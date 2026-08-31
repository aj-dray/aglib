/**
 * Three tools of our own, for the sandbox.
 *
 * `--tools ours` gives the agent these instead of Pi's. They are the same three
 * jobs Pi already does, which is the point: the comparison is between a tool we
 * wrote and the vendor's own, reaching the same sandbox through the same
 * executor and gated the same way.
 *
 * Nothing in a tool knows which sandbox it got. That is the port doing its job:
 * the same three work against a directory on this machine and against a
 * container, and the difference is one argument at construction.
 *
 * They used to be declared twice over — as `Tool`s here and as raw definitions
 * for an in-process MCP server, because a vendor that could only be handed
 * *names* needed its hands replaced rather than filled. Pi's `state.tools` is a
 * list we fill, so one declaration is enough.
 *
 * A tool this application genuinely owns — a memory, a delegation — would go in
 * that list beside Pi's four and be gated identically. These three cannot
 * demonstrate that, because Pi already has them.
 */
import { defineTool, type Tool } from "aglib";
import type { Sandbox } from "aglib/sandbox";
import { z } from "zod";

export const sandboxTools = (sandbox: Sandbox): readonly Tool[] => [
  defineTool({
    name: "bash",
    description: "Run a shell command inside this agent's sandbox.",
    annotations: { sequential: true },
    schema: z.object({ command: z.string(), timeoutMs: z.number().int().default(300_000) }),
    execute: async ({ command, timeoutMs }, context) => {
      const output = await sandbox.exec({
        command,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!output.ok) return { content: `Command failed: ${output.error.message}`, isError: true };
      const { stdout, stderr, exitCode } = output.value;
      return {
        content: [stdout, stderr].filter(Boolean).join("\n") || `(no output, exit ${exitCode})`,
        details: output.value,
        ...(exitCode === 0 ? {} : { isError: true }),
      };
    },
  }),
  defineTool({
    name: "read_file",
    description: "Read a file from the sandbox.",
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
    description: "Write a file in the sandbox, creating or replacing it.",
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
