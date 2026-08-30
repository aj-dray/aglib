/**
 * Shell and file access on the operator's own machine.
 *
 * This is the honest half of the sandbox port. `isolation: "none"` is not a
 * weaker sandbox — it is a request for the host, made explicitly, by a program
 * whose entire purpose is to act on the machine it runs on. An agent that
 * needed containment would ask for `"required"` and this provider would refuse
 * rather than quietly hand it the host.
 */
import { defineTool, type Tool } from "aglib";
import type { Sandbox } from "aglib/sandbox";
import { z } from "zod";

export function shellTools(sandbox: Sandbox): readonly Tool[] {
  return [
    defineTool({
      name: "bash",
      description: "Run a shell command in the current working directory.",
      // Not read-only: it may write, and the broker uses this to decide whether
      // adjacent calls can run concurrently.
      annotations: { sequential: true },
      schema: z.object({ command: z.string(), timeoutMs: z.number().int().default(120_000) }),
      execute: async ({ command, timeoutMs }, context) => {
        const output = await sandbox.exec({
          command,
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (!output.ok) return { content: `Command failed: ${output.error.message}`, isError: true };
        const { stdout, stderr, exitCode } = output.value;
        return {
          // A non-zero exit is an outcome the model should see and reason about,
          // not a framework error.
          content: [stdout, stderr].filter(Boolean).join("\n") || `(no output, exit ${exitCode})`,
          details: output.value,
          ...(exitCode === 0 ? {} : { isError: true }),
        };
      },
    }),

    defineTool({
      name: "read_file",
      description: "Read a file from the working directory.",
      annotations: { readOnly: true },
      schema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const file = await sandbox.readFile({ path });
        return file.ok
          ? { content: file.value }
          : { content: `Cannot read ${path}: ${file.error.message}`, isError: true };
      },
    }),

    defineTool({
      name: "write_file",
      description: "Write a file in the working directory, creating or replacing it.",
      annotations: { sequential: true },
      schema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const written = await sandbox.writeFile({ path, content });
        return written.ok
          ? { content: `Wrote ${path} (${content.length} bytes).` }
          : { content: `Cannot write ${path}: ${written.error.message}`, isError: true };
      },
    }),
  ];
}
