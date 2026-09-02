/**
 * Three tools, declared once and consumed twice.
 *
 * The native loop takes them as `Tool`s through the executor. A vendor harness
 * that brought its own hands takes the same name, description and schema as an
 * in-process MCP server — which is how its hands get replaced with these. One
 * declaration, because two would drift and the drift would be invisible: the
 * model would simply be told a slightly different thing depending on which
 * harness it was running under.
 *
 * Nothing in a tool knows which sandbox it got. That is the port doing its job:
 * the same three work against a directory on this machine and against a
 * container, and the difference is one argument at construction.
 */
import { defineTool, type Tool, type ToolContext, type ToolResult } from "aglib";
import type { Sandbox } from "aglib/sandbox";
import { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  annotations?: Tool["spec"]["annotations"];
  execute(args: Record<string, never>, context: ToolContext): ToolResult | Promise<ToolResult>;
}

const define = <S extends z.ZodObject<z.ZodRawShape>>(definition: {
  name: string;
  description: string;
  schema: S;
  annotations?: Tool["spec"]["annotations"];
  execute(args: z.output<S>, context: ToolContext): ToolResult | Promise<ToolResult>;
}): ToolDefinition => definition as unknown as ToolDefinition;

/** As `Tool`s, for a harness that runs its calls through our executor. */
export const sandboxTools = (sandbox: Sandbox): readonly Tool[] =>
  sandboxToolDefinitions(sandbox).map((definition) => defineTool(definition as never));

export function sandboxToolDefinitions(sandbox: Sandbox): readonly ToolDefinition[] {
  return [
    define({
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
    define({
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
    define({
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
}
