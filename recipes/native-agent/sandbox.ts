/**
 * Where commands run, and the one hand that runs them.
 *
 * Two providers, chosen at the command line, and the choice is a real one
 * rather than a setting. `local` asks for `isolation: "none"` — not a weaker
 * sandbox but an explicit request for the host, made by a program whose purpose
 * is to act on the machine it runs on. `docker` asks for `"required"`, and a
 * provider that cannot deliver it fails instead of quietly handing back the
 * host. That asymmetry is the whole of the port's honesty, and it is worth a
 * recipe exercising both sides of it.
 *
 * One tool, deliberately. Read, write, edit, glob and grep are all commands the
 * model already knows, and every one of them added here would be a second name
 * for something `bash` does. What a dedicated tool buys — a schema the model
 * cannot get wrong, an annotation the broker can read — is worth it for
 * `memory` and `load_skill`, which have no shell equivalent, and worth nothing
 * for `cat`.
 */
import { defineTool, type Tool } from "aglib";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createDockerSandboxProvider } from "aglib/sandbox/adapters/docker";
import type { Sandbox } from "aglib/sandbox";
import { z } from "zod";

export const sandboxKinds = ["local", "docker"] as const;
export type SandboxKind = (typeof sandboxKinds)[number];

/** The image a container is made from. Small, and has a shell. */
export const dockerImage = process.env["AGLIB_DOCKER_IMAGE"] ?? "alpine:3";

export async function openSandbox(kind: SandboxKind): Promise<Sandbox> {
  const provider = kind === "docker"
    ? createDockerSandboxProvider({ image: dockerImage })
    : createLocalSandboxProvider({ root: process.cwd() });

  const sandbox = await provider.create({
    // The one line where the two differ, and it is the line that matters.
    isolation: kind === "docker" ? "required" : "none",
    network: { mode: "unrestricted" },
  });
  if (!sandbox.ok) throw new Error(`sandbox (${kind}): ${sandbox.error.message}`);
  return sandbox.value;
}

export function bashTools(sandbox: Sandbox): readonly Tool[] {
  return [
    defineTool({
      name: "bash",
      description: `Run a shell command. Working directory is ${sandbox.root}. This is your only hand: read, write, search and edit files with it.`,
      // Not read-only: it may write, and the broker reads this to decide
      // whether adjacent calls may run concurrently.
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
          // A non-zero exit is an outcome the model should read and reason
          // about, not a framework error.
          content: [stdout, stderr].filter(Boolean).join("\n") || `(no output, exit ${exitCode})`,
          details: output.value,
          ...(exitCode === 0 ? {} : { isError: true }),
        };
      },
    }),
  ];
}
