/**
 * A machine on this computer, in a container.
 *
 * The port says isolation is requested and either enforced or refused, and
 * until this existed nothing in the package could answer the first half: the
 * local provider runs with the host's authority and says so, which makes the
 * contract honest and leaves it unimplementable. A caller that wanted the thing
 * the port describes had to go and write it, and every one of them wrote the
 * same file.
 *
 * Docker rather than a hosted provider because it needs no account, no vendor
 * SDK and no network: the daemon is on the machine, the client is a program,
 * and the whole adapter is argument arrays. That keeps the package's one
 * dependency one, and it means the isolation a caller asks for is testable on a
 * laptop rather than only on somebody's bill.
 *
 * A container is also what makes a remote agent reachable. The host answers on
 * `host.docker.internal` from inside, so a process started in here can call the
 * application that started it without a tunnel to the open internet.
 */
import { spawn as spawnProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { CommandResult, Sandbox, SandboxError, SandboxProcess, SandboxProvider } from "../sandbox.js";
import { err, ok, type Result } from "../../result.js";

/** Docker's own client. Its absence is the one failure worth naming plainly. */
const DOCKER = "docker";

/** The address the host answers on from inside a container. Docker Desktop
 * publishes it; `host-gateway` is what makes it true on a plain Linux daemon
 * too, so one URL works either place. Not exported: nothing composes it yet,
 * and a name with no consumer is surface with a cost. */
const HOST_ADDRESS = "host.docker.internal";

/**
 * A command may produce useful output; no command may consume the host by
 * streaming forever. Collected output past this — the two streams together, and
 * a file read through `cat` with them — is refused rather than truncated
 * silently, because a caller that asked for a file and got most of one has no
 * way to tell.
 *
 * Refusing ends this client and not the command: what `docker exec` started
 * keeps running in the container, where the container's own lifetime reaps it.
 */
const MAX_OUTPUT_BYTES = 1_000_000;

export interface DockerSandboxProviderOptions {
  /** The image every container is made from. */
  image: string;
  /**
   * How long a container lives before it reaps itself, in seconds. Defaults to
   * an hour. It exists because a process that died without closing would
   * otherwise leave a machine that outlives the laptop's next reboot.
   */
  lifetimeSeconds?: number;
  /** Where relative paths resolve, and the containers' working directory. Defaults to `/home/user`. */
  root?: string;
  /** Deadline for one `docker` call, in milliseconds. Composed with the caller's signal. */
  requestTimeoutMs?: number;
}

type Ran = { stdout: string; stderr: string; code: number };

/** Everything this adapter reports. `retryable` follows the code rather than
 * being decided call by call: a daemon that is not there may be there in a
 * moment, and a denied path never will be. */
function failure(code: SandboxError["code"], message: string): Result<never, SandboxError> {
  return err({ code, message, retryable: code === "unavailable" || code === "timeout" });
}

/** The one place an abort becomes a code: a deadline reads `timeout`, and
 * anything else is the caller changing its mind. */
function aborted(signal: AbortSignal | undefined, reason?: unknown): Result<never, SandboxError> {
  const cause = (signal?.aborted ? signal.reason : undefined) ?? reason;
  const timedOut = typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "TimeoutError";
  return timedOut
    ? failure("timeout", "Sandbox operation timed out")
    : failure("cancelled", "Sandbox operation cancelled");
}

/**
 * One `docker` invocation.
 *
 * Nothing goes through a shell, so a path or an environment value is an
 * argument and never something to quote. `node:child_process` rather than
 * `Bun.spawn` because there is no reason for this adapter to be less portable
 * than the daemon it talks to.
 *
 * An abort or a deadline ends this client only. A command it started is still
 * the container's, and runs there until the container's lifetime reaps it.
 */
function docker(input: {
  argv: readonly string[];
  stdin?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<Result<Ran, SandboxError>> {
  return new Promise((settle) => {
    const deadline = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    let child;
    try {
      child = spawnProcess(DOCKER, [...input.argv], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(input.environment ? { env: input.environment } : {}),
        signal,
      });
    } catch (error) {
      settle(failure("unavailable", error instanceof Error ? error.message : String(error)));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    const collect = (into: Buffer[], chunk: Buffer) => {
      if (exceeded) return;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        into.push(kept);
        bytes += kept.byteLength;
      }
      if (bytes >= MAX_OUTPUT_BYTES) { exceeded = true; child.kill(); }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => { /* the child exited before it read its input */ });
    child.stdin.end(input.stdin ?? "");
    child.on("error", (error) => {
      if (signal.aborted) { settle(aborted(input.signal, signal.reason)); return; }
      settle(failure(
        "unavailable",
        (error as { code?: string }).code === "ENOENT" ? "docker is not on PATH" : error.message,
      ));
    });
    child.on("close", (code) => {
      if (signal.aborted) { settle(aborted(input.signal, signal.reason)); return; }
      if (exceeded) { settle(failure("failed", `Output exceeded ${MAX_OUTPUT_BYTES} bytes`)); return; }
      settle(ok({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      }));
    });
  });
}

/** The client failing means the daemon is unreachable or the container is gone;
 * either way the sandbox is not there to be used. */
const unavailable = (ran: Ran): Result<never, SandboxError> =>
  failure("unavailable", ran.stderr.trim() || ran.stdout.trim() || `docker exited ${ran.code}`);

/** What the daemon writes when the container is not there to run anything in.
 * It writes it to the same stderr the command has, so a match is a question to
 * put to the daemon and never an answer on its own. */
const looksGone = (stderr: string): boolean => /No such container|is not running/i.test(stderr);

/** Asks the daemon whether a container is there and running. */
const inspectRunning = (id: string, config: Settled, signal?: AbortSignal): Promise<Result<Ran, SandboxError>> =>
  docker({
    argv: ["inspect", "--format", "{{.State.Running}}", id],
    timeoutMs: config.requestTimeoutMs,
    ...(signal ? { signal } : {}),
  });

/** How that answer reads. A daemon that could not be asked is not a container
 * that is running. */
const running = (state: Result<Ran, SandboxError>): boolean =>
  state.ok && state.value.code === 0 && state.value.stdout.trim() === "true";

/**
 * Resolves `path` against `root`, and answers only when it stayed inside.
 *
 * POSIX by hand: these are paths in the container, not on the calling machine,
 * so `node:path` would resolve them against the wrong filesystem's rules.
 *
 * Lexical, and only lexical: a symlink under the root that points out of it is
 * followed by the filesystem this cannot see. Confining paths to the root is a
 * guard against slips, and the container is the boundary that holds.
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

/** Single-quoted for `/bin/sh`, so a directory name with a space or a quote in
 * it is a directory name and not the start of another command. */
const quoted = (value: string): string => `'${value.split("'").join("'\\''")}'`;

/**
 * The `--env NAME` flags for an environment, or a refusal.
 *
 * Named rather than valued: the value travels in this client's own environment,
 * so nothing a model typed is ever pasted into an argument or published in the
 * host's process table, where an agent's credentials would be readable by
 * anything on the machine. A name that is itself an assignment would defeat
 * that — `docker` would take it whole and set a variable the caller never
 * named, dropping the value it did — so it is refused rather than passed.
 */
function envFlags(env: Readonly<Record<string, string>> | undefined): Result<readonly string[], SandboxError> {
  const flags: string[] = [];
  for (const name of Object.keys(env ?? {})) {
    if (name === "" || name.includes("=")) {
      return failure("failed", `'${name}' is not the name of an environment variable`);
    }
    flags.push("--env", name);
  }
  return ok(flags);
}

type Settled = Required<DockerSandboxProviderOptions>;

/**
 * @param base Set for every call, under each call's own. Carries `create`'s
 * `env` and its `secrets` together, because to a container they are the same
 * thing — see the `secrets: "plain"` this reports.
 */
function dockerSandbox(id: string, config: Settled, base: Readonly<Record<string, string>>): Sandbox {
  let closed = false;
  const gone = (): Result<never, SandboxError> => failure("unavailable", "Sandbox is closed");

  const call = (
    argv: readonly string[],
    request: { signal?: AbortSignal },
    stdin?: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ) => docker({
    argv,
    timeoutMs: config.requestTimeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(stdin === undefined ? {} : { stdin }),
    ...(environment ? { environment } : {}),
  });

  return {
    id,
    root: config.root,
    // The container is the containment: a shell the model talked into
    // misbehaving holds nothing this process has.
    isolation: "container",
    // A container has no egress this adapter controls, so a value it is given
    // is a value it holds. The names travel as `--env NAME` and the values in
    // this client's own environment, so nothing is published in the host's
    // process table — but inside the box it is readable, and that is what
    // "plain" says.
    secrets: "plain",

    async exec(request): Promise<Result<CommandResult, SandboxError>> {
      if (closed) return gone();
      const cwd = request.cwd ? within(config.root, request.cwd) : config.root;
      if (!cwd) return failure("denied", "Working directory is outside the sandbox root");
      if (request.signal?.aborted) return aborted(request.signal);
      const environment = { ...base, ...request.env };
      const named = envFlags(environment);
      if (!named.ok) return err(named.error);
      // The directory is made rather than required — `docker exec -w` refuses
      // one that is not there yet, and a command's cwd is the model's to name.
      // The command follows on its own line, exactly as written, so there is no
      // second round of quoting for it to be mangled by.
      const script = `mkdir -p ${quoted(cwd)} && cd ${quoted(cwd)} || exit 1\n${request.command}`;
      const ran = await call(
        ["exec", ...named.value, "--interactive", id, "/bin/sh", "-c", script],
        request,
        undefined,
        named.value.length ? { ...process.env, ...environment } : undefined,
      );
      if (!ran.ok) return err(ran.error);
      // A command's own non-zero exit is an outcome. Docker's own 125/126/127
      // are indistinguishable from a command that exited the same way, so only
      // a container that is gone is a failure — and the daemon is asked whether
      // it is, because the text saying so arrives on the stderr the command
      // writes to: a command that printed it could otherwise report its own
      // sandbox as gone, and be believed and retried.
      if (looksGone(ran.value.stderr) && !running(await inspectRunning(id, config, request.signal))) {
        return unavailable(ran.value);
      }
      return ok({ stdout: ran.value.stdout, stderr: ran.value.stderr, exitCode: ran.value.code });
    },

    async spawn(request): Promise<Result<SandboxProcess, SandboxError>> {
      if (closed) return gone();
      const cwd = request.cwd ? within(config.root, request.cwd) : config.root;
      if (!cwd) return failure("denied", "Working directory is outside the sandbox root");
      const [program, ...rest] = request.command;
      if (!program) return failure("failed", "spawn was given no command");
      const environment = { ...base, ...request.env };
      const named = envFlags(environment);
      if (!named.ok) return err(named.error);
      let child;
      try {
        child = spawnProcess(
          DOCKER,
          // `--workdir` where `exec` makes the directory first: docker refuses
          // to start a process in a path that is not there, and refuses it as
          // the process's own exit rather than as this call's result. A caller
          // that means to start something somewhere new makes it with `exec`.
          ["exec", "--interactive", ...named.value, "--workdir", cwd, id, program, ...rest],
          {
            stdio: ["pipe", "pipe", "pipe"],
            ...(named.value.length ? { env: { ...process.env, ...environment } } : {}),
          },
        );
      } catch (error) {
        return failure("unavailable", error instanceof Error ? error.message : String(error));
      }
      child.stdin.on("error", () => { /* the process ended before it read its input */ });
      // A launch that fails does so after this call returns, and an `error`
      // event with no listener is an uncaught exception that takes the host
      // process down. No `close` follows it either, so `exited` would never
      // settle. Waiting for the launch makes it the typed failure the port
      // already has a place for, and the listener stays attached afterwards so
      // that a later one is not fatal either.
      const failed = await new Promise<SandboxError | undefined>((settle) => {
        child.once("spawn", () => settle(undefined));
        child.once("error", (error: Error) => settle({
          code: "unavailable",
          message: (error as { code?: string }).code === "ENOENT" ? "docker is not on PATH" : error.message,
          retryable: true,
        }));
      });
      if (failed) return err(failed);
      return ok({
        write: (chunk: string) => { child.stdin.write(chunk); },
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        exited: new Promise<number>((settle) => { child.on("close", (code) => settle(code ?? 1)); }),
        kill: () => { child.kill(); },
      });
    },

    async readFile(request) {
      if (closed) return gone();
      const path = within(config.root, request.path);
      if (!path) return failure("denied", "Path is outside the sandbox root");
      if (request.signal?.aborted) return aborted(request.signal);
      const ran = await call(["exec", id, "cat", path], request);
      if (!ran.ok) return err(ran.error);
      if (ran.value.code !== 0) {
        return /No such file or directory/i.test(ran.value.stderr)
          ? failure("not-found", `No file at ${request.path}`)
          : failure("failed", ran.value.stderr.trim() || `cat exited ${ran.value.code}`);
      }
      return ok(ran.value.stdout);
    },

    async writeFile(request) {
      if (closed) return gone();
      const path = within(config.root, request.path);
      if (!path) return failure("denied", "Path is outside the sandbox root");
      if (request.signal?.aborted) return aborted(request.signal);
      const ran = await call(
        ["exec", "--interactive", id, "/bin/sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
        request,
        request.content,
      );
      if (!ran.ok) return err(ran.error);
      if (ran.value.code !== 0) {
        return failure("failed", ran.value.stderr.trim() || `write exited ${ran.value.code}`);
      }
      return ok(undefined);
    },

    async close() {
      if (closed) return ok(undefined);
      const ran = await docker({ argv: ["rm", "--force", id], timeoutMs: config.requestTimeoutMs });
      if (!ran.ok) return err(ran.error);
      // A container already gone is what closing asked for.
      if (ran.value.code !== 0 && !/No such container/i.test(ran.value.stderr)) return unavailable(ran.value);
      // Marked only once the machine is actually gone. Marking it before the
      // daemon answered would tell a caller retrying a reported refusal that
      // the container it is still paying for had been released.
      closed = true;
      return ok(undefined);
    },
  };
}

/**
 * Containers from the local daemon.
 *
 * Each runs nothing but a sleep long enough to serve a session and no longer,
 * so the container reaps itself on the same ceiling a hosted provider enforces.
 */
export function createDockerSandboxProvider(options: DockerSandboxProviderOptions): SandboxProvider {
  const config: Settled = {
    root: "/home/user",
    lifetimeSeconds: 60 * 60,
    requestTimeoutMs: 60_000,
    ...options,
  };

  return {
    id: "docker",

    async create(request) {
      // Merged here and not later: to a container these are one environment,
      // and keeping two would be two names for what every call has to combine
      // anyway. What the caller gains by having said `secrets` is the honest
      // `"plain"` this sandbox reports back.
      const base = {
        ...request.env,
        ...Object.fromEntries((request.secrets ?? []).map((secret) => [secret.env, secret.value])),
      };
      // Refused rather than ignored. A caller that named an allowlist and got
      // an unrestricted container would have no way to find that out.
      if (request.network.mode === "web-allowlist") {
        return failure("unsupported", "Docker is not configured for a web allowlist; use deny-all or unrestricted.");
      }
      if (request.signal?.aborted) return aborted(request.signal);

      // Reattaching must find a machine, not make one: a container that has
      // stopped is one whose files are already gone.
      if (request.reconnect !== undefined) {
        const found = await inspectRunning(request.reconnect, config, request.signal);
        // A daemon that could not be asked is not the same answer as a machine
        // that is not there, and only the second one is `not-found`.
        if (!found.ok) return err(found.error);
        if (!running(found)) return failure("not-found", `No sandbox ${request.reconnect}`);
        return ok(dockerSandbox(request.reconnect, config, base));
      }

      const ran = await docker({
        argv: [
          "run", "--detach", "--rm",
          // What the host answers to from inside. Docker Desktop resolves it
          // anyway; the mapping is what makes a plain Linux daemon agree.
          "--add-host", `${HOST_ADDRESS}:host-gateway`,
          ...(request.network.mode === "deny-all" ? ["--network", "none"] : []),
          "--workdir", config.root,
          "--env", `HOME=${config.root}`,
          config.image,
          "sleep", String(config.lifetimeSeconds),
        ],
        timeoutMs: config.requestTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!ran.ok) return err(ran.error);
      if (ran.value.code !== 0) return unavailable(ran.value);
      const id = ran.value.stdout.trim();
      if (!id) return failure("failed", "docker run named no container");
      // `docker run --detach` answers as soon as the container is created, and
      // every relative path is resolved against the root. One command from
      // inside is what says the machine is there to run them.
      const prepared = await docker({
        argv: ["exec", id, "mkdir", "-p", config.root],
        timeoutMs: config.requestTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!prepared.ok || prepared.value.code !== 0) {
        // The container exists whether or not it can be used, and this is the
        // last place its id is held: not removing it here leaks a machine that
        // nothing can reach and only its own lifetime ends.
        await docker({ argv: ["rm", "--force", id], timeoutMs: config.requestTimeoutMs });
        return prepared.ok
          ? failure("failed", prepared.value.stderr.trim() || `preparing ${config.root} exited ${prepared.value.code}`)
          : err(prepared.error);
      }
      return ok(dockerSandbox(id, config, base));
    },
  };
}
