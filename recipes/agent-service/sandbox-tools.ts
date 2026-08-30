/**
 * Command and file tools against this agent's sandbox.
 *
 * This file is deliberately near-identical to `personal-agent/shell.ts`. That
 * is the point of the port: the same three tools work against the operator's
 * own machine and against a Daytona box in another datacentre, and nothing in
 * the tool knows which it got. The difference is one argument at construction
 * — `isolation: "none"` for the local provider, `"required"` for a real container — and a provider that cannot
 * honour the request fails instead of silently downgrading it.
 */
import { defineTool, type Tool } from "aglib";
import type { Sandbox } from "aglib/sandbox";
import { z } from "zod";
import { define, type ServiceToolDefinition } from "./tools.ts";

/** As `Tool`s, for the native loop's executor. */
export function sandboxTools(sandbox: Sandbox): readonly Tool[] {
  return sandboxToolDefinitions(sandbox).map((definition) => defineTool(definition as never));
}

/**
 * Declared once, consumed twice: the native loop takes them as `Tool`s, and a
 * harness that brought its own hands takes the same name, description and
 * schema as an in-process MCP server — which is how its hands are replaced
 * with these.
 */
export function sandboxToolDefinitions(sandbox: Sandbox): readonly ServiceToolDefinition[] {
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
        return file.ok ? { content: file.value } : { content: `Cannot read ${path}: ${file.error.message}`, isError: true };
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
