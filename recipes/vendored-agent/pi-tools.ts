/**
 * Pi's own tools, run in our sandbox, declared as our tools.
 *
 * This is the whole argument for building on a vendor's library rather than
 * from scratch, and it is only possible because of two decisions Pi made:
 *
 *   - Its tools are **values**. `createCodingTools(cwd, options)` hands back
 *     objects with a name, a description, a schema and an implementation, so
 *     they can be taken and put somewhere else. Claude Code's are inside its
 *     process and can only be named; an agent driven over ACP will not even
 *     admit which it has.
 *   - Every one takes an **operations** seam — `BashOperations.exec`,
 *     `ReadOperations.readFile`, and so on. So the tool's prose, its schema,
 *     its truncation rules and its prompt guidance are reused verbatim while
 *     the file it reads and the shell it runs are ours.
 *
 * The result is a tool the model sees exactly as Pi wrote it, whose hands are
 * in our container, whose arguments we validate, and whose call `Decide` gates
 * like any other. Somebody else's tools, under our
 * authority, in our container — a stronger claim than either end of this
 * recipe could make alone.
 */
import {
  createCodingTools,
  type BashOperations, type EditOperations,
  type ReadOperations, type ToolsOptions, type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { err, ok, type Tool, type ToolContext, type ToolResult } from "aglib";
import type { JsonValue } from "aglib";
import type { Sandbox } from "aglib/sandbox";
import { z } from "zod";

export function piCodingTools(sandbox: Sandbox): readonly Tool[] {
  const files = fileOperations(sandbox);
  // Typed against Pi's own exported interfaces rather than cast past them. The
  // casts that stood here hid the two defects below: an environment Pi supplied
  // and we ignored, and a signal already aborted before the process started.
  const options: ToolsOptions = {
    bash: { operations: bashOperations(sandbox) },
    read: { operations: files },
    write: { operations: files },
    edit: { operations: files },
  };
  return createCodingTools(sandbox.root, options).map(adopt);
}

/**
 * One of theirs, as one of ours.
 *
 * Built by hand rather than through `defineTool`, for one reason: the spec
 * carries *their* schema unchanged. Handing it to `defineTool` would mean
 * converting to zod and back, and the model would be shown a schema neither
 * they nor we wrote. Validation still happens — `fromJSONSchema` gives a
 * checker for the same document — so arguments are parsed before any authority
 * decision sees them, exactly as the port requires.
 */
function adopt(tool: ReturnType<typeof createCodingTools>[number]): Tool {
  const validator = z.fromJSONSchema(tool.parameters as never);
  return Object.freeze({
    spec: Object.freeze({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JsonValue,
      annotations: { sequential: true },
    }),
    prepare(raw: unknown) {
      const parsed = validator.safeParse(raw);
      if (!parsed.success) {
        return err({ content: `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`, isError: true });
      }
      return ok({
        input: parsed.data as JsonValue,
        run: async (context: ToolContext): Promise<ToolResult> => {
          const answered = await tool.execute(context.callId, parsed.data, context.signal);
          return {
            content: answered.content
              .filter((part): part is { type: "text"; text: string } => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
            ...(answered.details !== undefined && answered.details !== null
              ? { details: answered.details as JsonValue } : {}),
            // No `isError` to read: Pi's tools throw on failure rather than
            // encoding it in the result, and our executor turns a throw into an
            // error result. The cast that used to sit here hid that, and read a
            // field the type never had.
          };
        },
      });
    },
  });
}

/** Their shell, our box. `spawn` rather than `exec` because they stream. */
function bashOperations(sandbox: Sandbox): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      // Refused before anything is started. A caller that has already given up
      // should not be charged for a container starting a process for it.
      if (options.signal?.aborted) throw new Error("aborted");
      const started = await sandbox.spawn({
        command: ["sh", "-c", command],
        cwd,
        // Pi sets PI_* session variables here and its own tool guidance refers
        // to them. Dropping them made that guidance describe an environment the
        // command could not see.
        ...(options.env ? { env: options.env as Record<string, string> } : {}),
      });
      if (!started.ok) throw new Error(started.error.message);
      const process = started.value;

      const stop = () => { process.kill(); };
      options.signal?.addEventListener("abort", stop, { once: true });
      const deadline = options.timeout ? setTimeout(stop, options.timeout * 1000) : undefined;

      const pump = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) options.onData(Buffer.from(chunk));
      };
      try {
        await Promise.all([pump(process.stdout), pump(process.stderr)]);
        return { exitCode: await process.exited };
      } finally {
        if (deadline) clearTimeout(deadline);
        options.signal?.removeEventListener("abort", stop);
      }
    },
  };
}

/**
 * Their file tools, our box.
 *
 * One object serves read, write and edit because between them they ask for
 * four methods and three are shared. A second copy per tool would be three
 * names for one fact.
 */
function fileOperations(sandbox: Sandbox): ReadOperations & WriteOperations & EditOperations {
  const read = async (path: string): Promise<Buffer> => {
    const file = await sandbox.readFile({ path });
    if (!file.ok) throw new Error(file.error.message);
    return Buffer.from(file.value);
  };
  return {
    readFile: read,
    access: async (path: string) => { await read(path); },
    writeFile: async (path: string, content: string) => {
      const written = await sandbox.writeFile({ path, content });
      if (!written.ok) throw new Error(written.error.message);
    },
    mkdir: async (directory: string) => {
      const made = await sandbox.exec({ command: `mkdir -p ${JSON.stringify(directory)}` });
      if (!made.ok) throw new Error(made.error.message);
    },
  };
}
