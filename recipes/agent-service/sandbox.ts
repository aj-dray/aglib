/**
 * Where an agent's hands are.
 *
 * One env var chooses. Everything downstream — the agent process, its shell,
 * its files — is started through the returned `Sandbox`, so changing this
 * choice moves the whole agent rather than relabelling it.
 */
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createDockerSandboxProvider } from "aglib/sandbox/adapters/docker";
import type { Sandbox, SandboxError, Secret } from "aglib/sandbox";
import { err, type Result } from "aglib";
import { join } from "node:path";
import { createDaytonaProvider } from "./daytona.ts";
import { secret } from "./credentials.ts";
import { serviceHome } from "./home.ts";

export const sandboxRoot = process.env["SANDBOX_ROOT"] ?? join(serviceHome, "sandboxes");

export function openSandbox(
  input: {
    sessionId: string;
    /**
     * What a process in here will need to authenticate with. Handed to the
     * provider rather than set as environment, so one that can keep the value
     * out of the box does — and the sandbox says which it did.
     */
    secrets?: readonly Secret[];
    reconnect?: string;
  },
): Promise<Result<Sandbox, SandboxError>> {
  const secrets = input.secrets?.length ? { secrets: input.secrets } : {};
  const provider = process.env["SANDBOX"] ?? "local";
  if (provider === "local") {
    // The host, bounded to a directory. It answers `isolation: "none"` and
    // would refuse `"required"`, which is the honest description of what a
    // directory on the operator's own machine actually is. A provider per
    // session, because where a sandbox lives is a property of the provider —
    // and the session id is what makes one session's files its own.
    return createLocalSandboxProvider({ root: join(sandboxRoot, input.sessionId) })
      .create({ isolation: "none", network: { mode: "unrestricted" }, ...secrets });
  }
  if (provider === "docker") {
    // The isolation the local provider refuses, on the operator's own machine
    // and with no account: the daemon is here, and a container is a container.
    // `DOCKER_IMAGE` decides what the agent finds inside it.
    return createDockerSandboxProvider({
      image: process.env["DOCKER_IMAGE"] ?? "alpine:3",
      ...(process.env["DOCKER_LIFETIME_SECONDS"]
        ? { lifetimeSeconds: Number(process.env["DOCKER_LIFETIME_SECONDS"]) }
        : {}),
    }).create({
      isolation: "required",
      // Stated, not defaulted, exactly as for a hosted box: this one runs
      // whatever the agent types too.
      network: { mode: "unrestricted" },
      ...secrets,
      ...(input.reconnect ? { reconnect: input.reconnect } : {}),
    });
  }

  if (provider === "daytona") {
    const apiKey = secret("daytona");
    if (!apiKey) {
      return Promise.resolve(err<SandboxError>({
        code: "denied", message: "Not connected to daytona.", retryable: false,
      }));
    }
    // A real container, so the isolation the local provider refuses is asked
    // for here and actually delivered.
    return createDaytonaProvider({
      apiKey,
      ...(process.env["DAYTONA_SNAPSHOT"] ? { snapshot: process.env["DAYTONA_SNAPSHOT"] } : {}),
      // Sizing needs an image: a snapshot carries its own resources and there
      // is nowhere to override them at creation.
      ...(process.env["DAYTONA_IMAGE"]
        ? {
            image: process.env["DAYTONA_IMAGE"],
            resources: {
              ...(process.env["DAYTONA_DISK"] ? { disk: Number(process.env["DAYTONA_DISK"]) } : {}),
              ...(process.env["DAYTONA_CPU"] ? { cpu: Number(process.env["DAYTONA_CPU"]) } : {}),
              ...(process.env["DAYTONA_MEMORY"] ? { memory: Number(process.env["DAYTONA_MEMORY"]) } : {}),
            },
          }
        : {}),
      // Sessions are resumed, so their boxes are kept by default. Set this when
      // running throwaway work: a stopped box holds its whole disk allocation,
      // and an afternoon of them exhausts the account.
      ...(process.env["DAYTONA_DISCARD"] === "1" ? { onClose: "delete" as const } : {}),
    }).create({
      isolation: "required",
      // Stated, not defaulted. This box runs whatever the agent types, so the
      // outbound posture is a decision the service makes out loud.
      network: { mode: "unrestricted" },
      ...secrets,
      ...(input.reconnect ? { reconnect: input.reconnect } : {}),
    });
  }

  return Promise.resolve(err<SandboxError>({
    code: "unsupported",
    message:
      `No sandbox provider '${provider}' is built. Implement SandboxProvider — exec, spawn, readFile, ` +
      `writeFile, close — and add it here. Nothing else changes.`,
    retryable: false,
  }));
}
