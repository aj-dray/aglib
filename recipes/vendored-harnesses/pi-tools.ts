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
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { err, ok, type Tool, type ToolContext, type ToolResult } from "aglib";
import type { JsonValue } from "aglib";
import type { Sandbox } from "aglib/sandbox";
import { z } from "zod";

/** What Pi hands back. Read structurally: its generics are richer than this needs. */
interface PiTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(callId: string, params: unknown, signal?: AbortSignal): Promise<{
    content: readonly { type?: string; text?: string }[];
    details?: unknown;
    isError?: boolean;
  }>;
}

export function piCodingTools(sandbox: Sandbox): readonly Tool[] {
  const theirs = createCodingTools(sandbox.root, {
    bash: { operations: bashOperations(sandbox) },
    read: { operations: fileOperations(sandbox) },
    write: { operations: fileOperations(sandbox) },
    edit: { operations: fileOperations(sandbox) },
  } as never) as unknown as readonly PiTool[];
  return theirs.map(adopt);
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
function adopt(tool: PiTool): Tool {
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
            content: answered.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
            ...(answered.details !== undefined && answered.details !== null
              ? { details: answered.details as JsonValue } : {}),
            ...(answered.isError ? { isError: true } : {}),
          };
        },
      });
    },
  });
}

/** Their shell, our box. `spawn` rather than `exec` because they stream. */
function bashOperations(sandbox: Sandbox) {
  return {
    exec: async (
      command: string,
      cwd: string,
      options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
    ): Promise<{ exitCode: number | null }> => {
      const started = await sandbox.spawn({ command: ["sh", "-c", command], cwd });
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
function fileOperations(sandbox: Sandbox) {
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
