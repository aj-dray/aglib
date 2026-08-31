import type { Sandbox, SandboxError, SandboxProcess, SandboxProvider } from "../sandbox.js";
import { err, ok, type Result } from "../../result.js";
import { spawn as spawnProcess } from "node:child_process";
import { Readable } from "node:stream";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Commands and files on the host, with the host's authority.
 *
 * This is not a sandbox and does not pretend to be one. Asking it for
 * `isolation: "required"` returns `unsupported` — the caller finds out by
 * failing rather than by reading a boolean it was free to ignore.
 */
export function createLocalSandboxProvider(options: { root?: string } = {}): SandboxProvider {
  return {
    id: "local",
    async create(input) {
      if (input.isolation === "required") {
        return err<SandboxError>({
          code: "unsupported",
          message: "The local provider runs on the host and cannot isolate. Choose a sandbox provider.",
          retryable: false,
        });
      }
      if (input.network.mode !== "unrestricted") {
        return err<SandboxError>({
          code: "unsupported",
          message: `The local provider cannot enforce network mode '${input.network.mode}'.`,
          retryable: false,
        });
      }
      // Where a sandbox lives is a property of the provider, not of one
      // request: the port's `create` names no root, so one provider answers for
      // one directory and a second directory is a second provider.
      return createLocalSandbox({
        root: options.root ?? process.cwd(),
        // Nothing here can substitute anything: a process on the host reads
        // its own environment, and there is no egress to intercept. The two
        // arrive merged, and the sandbox says `secrets: "plain"` so a caller
        // that minds can decline.
        env: {
          ...input.env,
          ...Object.fromEntries((input.secrets ?? []).map((secret) => [secret.env, secret.value])),
        },
      });
    },
  };
}

/**
 * Not exported. A sandbox is reached through its provider, like every other
 * one — a second constructor beside `createLocalSandboxProvider` was a second
 * way to make the same thing, and the one that skipped the port.
 */
async function createLocalSandbox(
  input: { root: string; env: Readonly<Record<string, string>> },
): Promise<Result<Sandbox, SandboxError>> {
  const root = resolve(input.root);
  await mkdir(root, { recursive: true });
  let closed = false;

  /**
   * A released sandbox is gone. Nothing was provisioned here, so closing frees
   * nothing — but a caller that closed and then ran a command has a bug, and
   * every other provider would have told it so.
   */
  const gone = (): Result<never, SandboxError> =>
    err({ code: "unavailable", message: "Sandbox is closed", retryable: false });

  /**
   * Whether `full` left `base`, reading the two paths and nothing else.
   *
   * A path that left is `..`, begins with a `..` segment, or has no relation to
   * the base at all. A *name* beginning with two dots is a file in it, and a
   * bare `startsWith("..")` refused those too.
   */
  const escapes = (base: string, full: string): boolean => {
    const inside = relative(base, full);
    return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  };

  /**
   * The path a call would really touch.
   *
   * `realpath` fails on something that is not there yet, which `writeFile` is
   * entitled to be given — so the nearest existing ancestor is resolved and the
   * rest re-joined. That is enough: only an existing directory can be the
   * symlink, and a name that does not exist cannot redirect anything.
   */
  const settled = async (full: string): Promise<string> => {
    const parts: string[] = [];
    let at = full;
    for (;;) {
      try { return resolve(await realpath(at), ...parts.reverse()); }
      catch { /* not there yet — try its parent */ }
      const up = dirname(at);
      if (up === at) return full;
      parts.push(basename(at));
      at = up;
    }
  };

  const realRoot = await realpath(root);

  /**
   * Confines paths to the chosen root. Not isolation — a guard against slips —
   * but it does consult the filesystem, because a lexical check alone is not
   * even that.
   *
   * A symlink under the root pointing out of it is followed by every call that
   * matters, and `readFile`/`writeFile` are exactly the calls an application
   * hands to a model. Lexically `notes/link/passwd` never leaves the root; on
   * disk it was `/etc/passwd`. So the lexical test runs first, because it is
   * free and catches `../` before any syscall, and the resolved one decides.
   */
  const within = async (path: string): Promise<Result<string, SandboxError>> => {
    const full = isAbsolute(path) ? resolve(path) : resolve(join(root, path));
    const denied = err<SandboxError>({
      code: "denied", message: `Path escapes the sandbox root: ${path}`, retryable: false,
    });
    if (escapes(root, full)) return denied;
    return escapes(realRoot, await settled(full)) ? denied : ok(full);
  };

  return ok({
    id: `local:${root}`,
    root,
    isolation: "none",
    // The host's own environment is readable by anything running in it.
    secrets: "plain",

    async exec({ command, cwd, env, signal }) {
      if (closed) return gone();
      const target = cwd ? await within(cwd) : ok(root);
      if (!target.ok) return target;
      // Checked before anything is started: a caller that has already given up
      // gets `cancelled` rather than the command it no longer wants.
      if (signal?.aborted) return err(abortOrFail(undefined, signal));
      try {
        const child = spawnProcess("/bin/sh", ["-lc", command], {
          cwd: target.value,
          env: { ...process.env, ...input.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const collected = new Promise<[string, string, number]>((settle, fail) => {
          const out: Buffer[] = [];
          const errs: Buffer[] = [];
          child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
          child.stderr.on("data", (chunk: Buffer) => errs.push(chunk));
          child.on("error", fail);
          child.on("close", (code) => settle([
            Buffer.concat(out).toString("utf8"),
            Buffer.concat(errs).toString("utf8"),
            code ?? 1,
          ]));
        });
        // Raced, not awaited. Killing the shell does not settle this promptly:
        // the orphan it spawned holds the pipes open, so a `sleep 5` cancelled
        // at 200ms answered five seconds later — and by then the exit code
        // reads as an ordinary signal death rather than a cancellation.
        const finished = signal
          ? await Promise.race([
              collected.then((done) => ({ done })),
              new Promise<{ done?: undefined }>((settle) => {
                signal.addEventListener("abort", () => settle({}), { once: true });
              }),
            ])
          : { done: await collected };
        if (!finished.done) {
          // The shell, not everything under it: a command that spawned its own
          // child leaves that child to finish. The same limit the container
          // adapter has, for the same reason — this is a process, not a group.
          child.kill();
          return err(abortOrFail(undefined, signal));
        }
        const [stdout, stderr, exitCode] = finished.done;
        // A non-zero exit is an outcome the caller reasons about, not an error.
        return ok({ stdout, stderr, exitCode });
      } catch (error) {
        return err(abortOrFail(error, signal));
      }
    },

    async spawn({ command, cwd, env }) {
      if (closed) return gone();
      const target = cwd ? await within(cwd) : ok(root);
      if (!target.ok) return target;
      const [executable, ...rest] = command;
      if (!executable) {
        return err<SandboxError>({ code: "failed", message: "spawn needs a command", retryable: false });
      }
      const child = spawnProcess(executable, rest, {
        cwd: target.value,
        env: { ...process.env, ...input.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      // A launch failure arrives asynchronously, and an unhandled `error` event
      // is an uncaught exception — which in a service is the whole process, not
      // the sandbox. Awaited here so it comes back typed, and the listener stays
      // on so a later one is not fatal either.
      const launched = await new Promise<SandboxError | undefined>((settle) => {
        child.once("spawn", () => settle(undefined));
        child.once("error", (error: NodeJS.ErrnoException) => settle({
          code: "unavailable",
          message: error.code === "ENOENT" ? `No such command: ${executable}` : error.message,
          retryable: true,
        }));
      });
      if (launched) return err(launched);
      child.on("error", () => { /* reported once; a later one is not fatal */ });
      child.stdin.on("error", () => { /* the process ended before it read its input */ });
      return ok<SandboxProcess>({
        write: (chunk) => { child.stdin.write(chunk); },
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        // `exit` fires when the process ends; `close` waits for its stdio to
        // close too, which a caller that never reads `stdout` may not cause —
        // `Readable.toWeb` leaves the pipe unread until somebody pulls from it.
        // Whichever arrives first answers, so a killed process is reported as
        // gone whether or not anyone was listening to it.
        exited: new Promise<number>((settle) => {
          child.on("exit", (code) => settle(code ?? 1));
          child.on("close", (code) => settle(code ?? 1));
        }),
        kill: () => {
          child.kill();
          // SIGTERM is a request. This port says the process can be killed, so
          // a process that declines to handle it does not get to leave `exited`
          // pending for as long as it likes. Cleared on exit, and unreferenced,
          // so a prompt death leaves nothing holding the loop open.
          const escalate = setTimeout(() => child.kill("SIGKILL"), 2_000);
          escalate.unref?.();
          child.once("exit", () => clearTimeout(escalate));
        },
      });
    },

    async readFile({ path, signal }) {
      if (closed) return gone();
      const target = await within(path);
      if (!target.ok) return target;
      if (signal?.aborted) return err(abortOrFail(undefined, signal));
      try { return ok(await readFile(target.value, "utf8")); }
      catch (error) { return err(fileError(error, path)); }
    },

    async writeFile({ path, content, signal }) {
      if (closed) return gone();
      const target = await within(path);
      if (!target.ok) return target;
      if (signal?.aborted) return err(abortOrFail(undefined, signal));
      try {
        await mkdir(join(target.value, ".."), { recursive: true });
        await writeFile(target.value, content, "utf8");
        return ok(undefined);
      } catch (error) { return err(fileError(error, path)); }
    },

    async close() { closed = true; return ok(undefined); /* nothing was provisioned to release */ },
  });
}

function abortOrFail(error: unknown, signal?: AbortSignal): SandboxError {
  if (signal?.aborted) {
    const timedOut = (signal.reason as Error | undefined)?.name === "TimeoutError";
    // A deadline may be met on a second attempt with a longer one; a caller
    // that changed its mind has nothing to act on. The container adapter agrees.
    return timedOut
      ? { code: "timeout", message: "Command timed out", retryable: true }
      : { code: "cancelled", message: "Command cancelled", retryable: false };
  }
  return { code: "failed", message: error instanceof Error ? error.message : String(error), retryable: false };
}

const fileError = (error: unknown, path: string): SandboxError =>
  (error as { code?: string }).code === "ENOENT"
    ? { code: "not-found", message: `No such file: ${path}`, retryable: false }
    : { code: "failed", message: error instanceof Error ? error.message : String(error), retryable: false };
