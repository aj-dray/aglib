/**
 * A Daytona sandbox: a container in someone else's datacentre.
 *
 * This is the adapter that makes `isolation: "required"` answerable. The local
 * provider refuses that request because a directory on the operator's machine
 * is not isolation; this one delivers a container and says so.
 *
 * It lives in this recipe rather than in the package for the reason
 * `docs/CODE.md` gives: it needs a vendor dependency, and core depends only on
 * `zod`. Like the Postgres store and the Claude Code harness, it is written
 * from nothing but the public port.
 *
 * The method that matters is `spawn`. A coding agent runs its own shell in its
 * own process, and only delegates the calls it chooses to — proven by watching
 * Claude Code run `cat` locally while a protocol client sat unused beside it.
 * So containment is not a matter of routing an agent's file requests here; the
 * agent itself has to start here. Daytona's session commands give a real duplex
 * channel — async command, streamed logs, input by id — which is enough to
 * speak JSON-RPC to a process running in the box.
 */
import type { CommandResult, NetworkPolicy, Sandbox, SandboxError, SandboxProcess, SandboxProvider } from "aglib/sandbox";
import { err, ok, type Result } from "aglib";
import { Daytona, type Sandbox as Box } from "@daytonaio/sdk";
import type { Secret as PortSecret } from "aglib/sandbox";
import { createHash } from "node:crypto";

export interface DaytonaOptions {
  apiKey: string;
  /**
   * A prepared snapshot. Without one, Daytona picks its default — and with it
   * that default's disk, cpu and memory, because a snapshot bakes its own
   * resources and `CreateSandboxFromSnapshotParams` has nowhere to override
   * them. Choosing a size therefore means either building a snapshot with the
   * resources you want, or creating from an `image` and stating them here.
   *
   * This is worth knowing before an account fills up: every box costs its
   * snapshot's whole disk allocation for as long as it exists, stopped or not.
   */
  snapshot?: string;
  /**
   * Build from an image instead, with resources you choose. Slower than a
   * snapshot unless the image is cached, and the only way the SDK lets a
   * caller set disk at creation.
   */
  image?: string;
  /** Only honoured with `image`; a snapshot's own resources win. In GiB. */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /** Minutes of inactivity before the box stops. It restarts on reconnect. */
  autoStopMinutes?: number;
  /**
   * What `close()` does.
   *
   * "stop" keeps the disk, so the next activation of a session reattaches to
   * the work already in it — right for a session that will be resumed, and the
   * default. "delete" reclaims it, which is what a finished or throwaway
   * session wants: a stopped box still holds its whole disk allocation against
   * the account, and enough of them exhaust it.
   */
  onClose?: "stop" | "delete";
}

/** Long enough for a build or a test suite. `exec` is not where a runaway is caught; the signal is. */
const COMMAND_SECONDS = 3600;

/** Daytona stops an idle box. A turn spent thinking is idle, so activity is refreshed while one runs. */
const KEEPALIVE_MS = 60_000;

export function createDaytonaProvider(options: DaytonaOptions): SandboxProvider {
  const daytona = new Daytona({ apiKey: options.apiKey });
  // Secrets are organisation-scoped and outlive every box, so the same value
  // asked for twice is the same secret. Held per provider so a run of sessions
  // costs one round trip each rather than one per box.
  const known = new Set<string>();

  return {
    id: "daytona",
    async create(input) {
      try {
        // Named and stored before the box exists, because the box is told a
        // name and never a value.
        const mounted = input.reconnect ? {} : await declare(daytona, input.secrets ?? [], known);
        const box = input.reconnect
          ? await reattach(daytona, input.reconnect)
          : await daytona.create({
              // An image and a snapshot are different creation calls, and only
              // the image one takes resources. Sending both would let a
              // caller set a disk size that is silently ignored.
              ...(options.image
                ? { image: options.image, ...(options.resources ? { resources: options.resources } : {}) }
                : options.snapshot ? { snapshot: options.snapshot } : {}),
              ...(input.env ? { envVars: { ...input.env } } : {}),
              ...(Object.keys(mounted).length ? { secrets: mounted } : {}),
              autoStopInterval: options.autoStopMinutes ?? 30,
              ...network(input.network),
              labels: { owner: "aglib-agent-service" },
            } as never);
        const root = (await box.getWorkDir()) ?? (await box.getUserRootDir()) ?? "/home/daytona";
        return ok(wrap(box, root, options.onClose ?? "stop"));
      } catch (error) {
        return err(failure(error));
      }
    },
  };
}

/**
 * Store each secret with Daytona and say which name each variable mounts.
 *
 * The name carries a digest of the value, so two different values are two
 * secrets and neither can overwrite the other — the alternative, one secret per
 * variable name, would have a rotated credential silently retune every session
 * still running on the old one. The cost is that rotating leaves the previous
 * secret in the organisation; it is inert, and deleting it is the operator's
 * call because another sandbox may still be mounting it.
 *
 * Creating one that is already there is the answer we wanted, so a conflict is
 * success. Anything else is not swallowed: a secret that did not store is a
 * variable the box would be given as a name with nothing behind it.
 */
async function declare(
  daytona: Daytona,
  secrets: readonly PortSecret[],
  known: Set<string>,
): Promise<Record<string, string>> {
  const mounted: Record<string, string> = {};
  for (const secret of secrets) {
    // `^[a-zA-Z_][a-zA-Z0-9_-]*$` is what Daytona accepts, and an environment
    // variable name already satisfies it. The prefix keeps this service's
    // secrets apart from everything else in the organisation.
    const digest = createHash("sha256").update(secret.value).digest("hex").slice(0, 12);
    const name = `aglib_${secret.env}_${digest}`;
    mounted[secret.env] = name;
    if (known.has(name)) continue;
    try {
      await daytona.secret.create({
        name,
        value: secret.value,
        description: `${secret.env} for aglib-agent-service`,
        ...(secret.hosts ? { hosts: [...secret.hosts] } : {}),
      });
    } catch (error) {
      if (!alreadyThere(error)) throw error;
    }
    known.add(name);
  }
  return mounted;
}

/** A name that is taken is a name that already holds this value: the digest says so. */
const alreadyThere = (error: unknown): boolean => {
  const status = (error as { statusCode?: number; status?: number } | null)?.statusCode
    ?? (error as { status?: number } | null)?.status;
  return status === 409 || /conflict|already exists/i.test((error as Error | null)?.message ?? "");
};

/** A stopped box is reattached to, not replaced: the work in it is the point. */
async function reattach(daytona: Daytona, id: string): Promise<Box> {
  const box = await daytona.get(id);
  if (box.state !== "started") {
    await box.start();
    await box.waitUntilStarted();
  }
  return box;
}

/**
 * The policy, as Daytona expresses it. A mode it cannot enforce is refused at
 * creation rather than accepted and quietly ignored.
 */
function network(policy: NetworkPolicy | undefined) {
  if (!policy || policy.mode === "unrestricted") return {};
  if (policy.mode === "deny-all") return { networkBlockAll: true };
  return { networkAllowList: policy.hosts.join(",") };
}

function wrap(box: Box, root: string, onClose: "stop" | "delete"): Sandbox {
  let sessions = 0;
  let released = false;

  return {
    id: box.id,
    root,
    // What was actually enforced, not what was asked for.
    isolation: "container",
    // The claim this provider exists to make good on. A secret is held by
    // Daytona, the box is given `dtn_secret_<id>`, and the value is put in at
    // the egress proxy on the way to the hosts that secret named. An agent
    // running here can spend the credential and cannot read it, which is the
    // difference between running somebody else's code and handing it your keys.
    secrets: "substituted",

    async exec({ command, cwd, env, signal }) {
      const directory = cwd === undefined ? root : within(root, cwd);
      if (!directory) return err(denied("Working directory"));
      if (signal?.aborted) return cancelled();
      try {
        // The server-side limit is named, because the default is short enough
        // to kill an ordinary build.
        const running = box.process.executeCommand(command, directory, { ...env }, COMMAND_SECONDS);
        // Raced, not awaited. Checking the signal only after the call returned
        // meant a caller that gave up at 200ms waited out the whole command
        // before hearing so — the answer was right and five seconds late, which
        // for cancellation is the same as being wrong. The command itself keeps
        // running in the box until its own limit: this is a remote process, and
        // abandoning it is all a caller can do from here.
        const outcome = signal
          ? await Promise.race([
              running.then((done) => ({ done })),
              new Promise<{ done?: undefined }>((settle) => {
                signal.addEventListener("abort", () => settle({}), { once: true });
              }),
            ])
          : { done: await running };
        if (!outcome.done) return cancelled();
        const done = outcome.done;
        if (signal?.aborted) return err<SandboxError>({ code: "cancelled", message: "Command cancelled", retryable: false });
        // Daytona returns one combined stream. Reporting it as stdout and
        // leaving stderr empty is what actually happened; splitting it would be
        // an invention.
        return ok<CommandResult>({ stdout: done.result ?? "", stderr: "", exitCode: done.exitCode ?? 0 });
      } catch (error) {
        return err(failure(error));
      }
    },

    /**
     * A long-lived process in the box, with its streams.
     *
     * Daytona has no pipe to hand back, so one is built: an async session
     * command for the process, streamed logs for output, and `sendSessionCommandInput`
     * for input. A PTY would have been the other option and is the wrong one —
     * echo and control codes corrupt a protocol that is one JSON object per line.
     */
    async spawn({ command, cwd, env }) {
      // The same confinement the other three methods do. It was missing here,
      // which is exactly the divergence a port with several implementations
      // produces when only some of them are checked.
      const directory = cwd === undefined ? root : within(root, cwd);
      if (!directory) return err(denied("Working directory"));
      const sessionId = `aglib-${box.id.slice(0, 8)}-${++sessions}`;
      try {
        await box.process.createSession(sessionId);
        const line = [
          ...Object.entries(env ?? {}).map(([name, value]) => `${name}=${shellQuote(value)}`),
          ...command.map(shellQuote),
        ].join(" ");
        const started = await box.process.executeSessionCommand(sessionId, {
          command: `cd ${shellQuote(directory)} && ${line}`,
          runAsync: true,
          // The session stream otherwise carries our input back with the
          // output. Harmless in a log, fatal for one JSON object per line: the
          // first `initialize` came back at us and we answered our own call.
          suppressInputEcho: true,
        });
        const commandId = started.cmdId;
        if (!commandId) {
          return err<SandboxError>({ code: "failed", message: "Daytona started no command.", retryable: true });
        }

        // `suppressInputEcho` above is the transport's own answer to this, and
        // this filter is the belt to its braces: the echo was observed, the
        // flag's effect has not yet been re-observed, and dropping a line we
        // literally wrote can never discard anything the agent said.
        const written: string[] = [];
        const out = channel((line) => {
          const at = written.indexOf(line);
          if (at === -1) return false;
          written.splice(at, 1);
          return true;
        });
        const errors = channel();
        let exit: (code: number) => void = () => undefined;
        const exited = new Promise<number>((resolve) => { exit = resolve; });

        void box.process
          .getSessionCommandLogs(sessionId, commandId, out.push, errors.push)
          .catch(() => undefined)
          .then(async () => {
            out.close();
            errors.close();
            const finished = await box.process.getSessionCommand(sessionId, commandId).catch(() => undefined);
            exit(finished?.exitCode ?? 0);
          });

        // Refreshed while the process lives: a turn spent waiting on a model
        // is idle by Daytona's reckoning, and the box would stop underneath it.
        const keepalive = setInterval(() => { void box.refreshActivity().catch(() => undefined); }, KEEPALIVE_MS);
        void exited.then(() => clearInterval(keepalive));

        const process_: SandboxProcess = {
          write: (chunk) => {
            for (const line of chunk.split("\n")) if (line) written.push(line);
            void box.process.sendSessionCommandInput(sessionId, commandId, chunk);
          },
          stdout: out.stream,
          stderr: errors.stream,
          exited,
          kill: () => {
            clearInterval(keepalive);
            void box.process.deleteSession(sessionId);
            out.close(); errors.close(); exit(143);
          },
        };
        return ok(process_);
      } catch (error) {
        return err(failure(error));
      }
    },

    async readFile({ path, signal }) {
      const target = within(root, path);
      if (!target) return err(denied("Path"));
      if (signal?.aborted) return cancelled();
      try {
        const bytes = await box.fs.downloadFile(target);
        return ok(new TextDecoder().decode(bytes));
      } catch (error) {
        return err(failure(error, path));
      }
    },

    async writeFile({ path, content, signal }) {
      const target = within(root, path);
      if (!target) return err(denied("Path"));
      if (signal?.aborted) return cancelled();
      try {
        await box.fs.uploadFile(Buffer.from(content, "utf8"), target);
        return ok(undefined);
      } catch (error) {
        return err(failure(error, path));
      }
    },

    async close() {
      // Stopping keeps the disk so the next activation reattaches to the work.
      // That is the right default and the wrong one for anything throwaway,
      // because a stopped box still holds its allocation.
      // A hosted box is billable, so a refusal is reported rather than
      // swallowed: a caller whose stop did not take is still being charged.
      if (released) return ok(undefined);
      released = true;
      const done = onClose === "delete" ? box.delete(60, true) : box.stop();
      try {
        await done;
        return ok(undefined);
      } catch (error) {
        // A box already gone is the state closing asked for. Reported as a
        // failure, closing twice looked like a refusal to release — the one
        // outcome a caller is meant to act on.
        const reported = failure(error, onClose === "delete" ? "delete" : "stop");
        return reported.code === "not-found" ? ok(undefined) : err(reported);
      }
    },
  };
}

/**
 * Callback logs into a readable stream, which is what the port hands back.
 *
 * `drop` is consulted per complete line, so a transport that echoes its own
 * input can suppress it. Buffering to line boundaries is what makes that
 * possible, and is free here because a chunk boundary is not a message
 * boundary anyway.
 */
function channel(drop?: (line: string) => boolean) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  let open = true;
  let buffer = "";

  const emit = (text: string) => { if (open && text) controller?.enqueue(encoder.encode(text)); };

  return {
    stream,
    push(chunk: string) {
      if (!open) return;
      if (!drop) { emit(chunk); return; }
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!drop(line)) emit(`${line}\n`);
      }
    },
    close() {
      if (!open) return;
      emit(buffer);
      buffer = "";
      open = false;
      try { controller?.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * Resolves `path` against `root`, and answers only when it stayed inside.
 *
 * POSIX by hand: these are paths in the box, not on this machine. Joining
 * without resolving let `../escape.md` out of the root and reach whatever was
 * there — the guard the port asks for, missing.
 */
function within(root: string, path: string): string | undefined {
  const base = root.replace(/\/+$/, "");
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined;
      continue;
    }
    segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  return resolved === base || resolved.startsWith(`${base}/`) ? resolved : undefined;
}

const denied = (what: string): SandboxError =>
  ({ code: "denied", message: `${what} is outside the sandbox root`, retryable: false });

/** A caller that gave up gets told so, on every method that takes a signal. */
const cancelled = (): Result<never, SandboxError> =>
  err({ code: "cancelled", message: "Cancelled", retryable: false });

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function failure(error: unknown, path?: string): SandboxError {
  const message = error instanceof Error ? error.message : String(error);
  if (path && /not found|no such/i.test(message)) {
    return { code: "not-found", message: `No such file: ${path}`, retryable: false };
  }
  if (/unauthor|forbidden|api key/i.test(message)) {
    return { code: "denied", message, retryable: false };
  }
  return { code: "unavailable", message, retryable: true };
}
