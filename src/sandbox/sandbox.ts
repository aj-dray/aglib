import type { Failure, Result } from "../result.js";

export interface SandboxError extends Failure {
  code: "unavailable" | "not-found" | "denied" | "timeout" | "cancelled" | "unsupported" | "failed";
}

export type NetworkPolicy =
  | { mode: "deny-all" }
  | { mode: "web-allowlist"; hosts: readonly string[] }
  | { mode: "unrestricted" };

/**
 * A finished command. A non-zero `exitCode` is an outcome, not a
 * `SandboxError`. A type alias rather than an interface so it satisfies
 * `JsonValue` structurally and can be handed to a tool result without a cast.
 */
export type CommandResult = { stdout: string; stderr: string; exitCode: number };

/**
 * A process still running, with its streams.
 *
 * `exec` waits and collects; this hands back the pipes. Both are on the port
 * because a provider implements each natively — a remote box has a one-shot
 * command API that is cheaper than holding a stream open, and an interactive
 * process cannot be expressed as a one-shot call at all.
 */
export interface SandboxProcess {
  write(chunk: string): void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/**
 * A credential a process in the sandbox needs, and where it may be sent.
 *
 * Named apart from plain environment because the two want different things
 * from a provider. Configuration is meant to be readable inside the box — a
 * model name is no use to a process that cannot read it. A credential is the
 * opposite: the box needs to *send* it, and every provider that can arrange
 * that without the box ever holding it should.
 *
 * Whether that happened is `Sandbox.secrets`, and it is a fact about the
 * provider rather than about any one secret.
 */
export interface Secret {
  /** The variable a process reads it from. */
  env: string;
  value: string;
  /**
   * Hosts this may be sent to. Enforced only where the value is substituted —
   * a provider holding the plaintext in the box cannot police what reads it,
   * and says so rather than implying otherwise. Absent means anywhere.
   */
  hosts?: readonly string[];
}

/**
 * One place commands run and files live.
 *
 * Every path is confined to `root`, and how far that confinement reaches
 * depends on what else is holding the line. Where the root is the only
 * boundary — a directory on the host — it is resolved against the filesystem,
 * because a symlink inside it that points out of it is followed by every call
 * that matters. Where a container or a machine is the boundary, the check is
 * lexical and the containment is the container's; a `realpath` per file call
 * would buy tidiness, not safety. The conformance suite asks only the first
 * kind for the stronger guarantee.
 */
export interface Sandbox {
  readonly id: string;
  readonly root: string;
  /** What was actually enforced. A provider never reports more than it delivers. */
  readonly isolation: "none" | "container" | "vm";
  /**
   * What became of the values in `secrets`.
   *
   * `"substituted"` — the box holds a reference, and the provider puts the
   * value in on the way out, to the hosts that secret named. A process here
   * cannot read it, and neither can anything it starts or anything it writes
   * to disk.
   *
   * `"plain"` — the value is in the environment, where any process here can
   * read it. Not a weaker form of the same thing: the caller asked for one and
   * got the other, and this is where it can find out. A caller handing a
   * long-lived credential to code it did not write may reasonably refuse to
   * continue.
   */
  readonly secrets: "substituted" | "plain";
  exec(input: { command: string; cwd?: string; env?: Readonly<Record<string, string>>; signal?: AbortSignal }):
    Promise<Result<CommandResult, SandboxError>>;
  /**
   * Start a process here and keep hold of it.
   *
   * This is the method that makes changing provider a change of *location*.
   * A coding agent driven over a protocol runs its own shell in its own
   * process; routing that agent's file and terminal requests through the port
   * only moves the calls it chooses to delegate. Starting the agent itself with
   * `spawn` moves all of it, because there is nowhere else for it to be.
   */
  spawn(input: { command: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }):
    Promise<Result<SandboxProcess, SandboxError>>;
  readFile(input: { path: string; signal?: AbortSignal }): Promise<Result<string, SandboxError>>;
  writeFile(input: { path: string; content: string; signal?: AbortSignal }): Promise<Result<void, SandboxError>>;
  /**
   * Release it. A refusal is reported, not swallowed: a hosted sandbox is
   * billable, so a caller whose termination did not take is still paying and
   * deserves to be told rather than to find out on an invoice.
   */
  close(): Promise<Result<void, SandboxError>>;
}

/**
 * Isolation is requested, not declared.
 *
 * A caller asks for `"required"` and a provider that runs on the host answers
 * `unsupported` rather than handing back something that merely says it is not
 * isolated. That is the difference between a contract and a disclaimer: the
 * old shape let a caller ignore a boolean, this one cannot be ignored.
 */
export interface SandboxProvider {
  readonly id: string;
  create(input: {
    isolation: "required" | "none";
    /**
     * Required, and deliberately not optional. This runs whatever a model
     * types, so outbound access is a decision someone has to make rather than
     * something a provider default can hand over quietly.
     */
    network: NetworkPolicy;
    /**
     * Set for everything started here, and inherited by whatever those start.
     *
     * Here rather than only on `exec` and `spawn` because a provider may have
     * to arrange it when the box is made: an agent that runs its own shell is
     * started once, and what it hands to its children is settled before any
     * call this port makes. A per-call `env` still wins over this for that call.
     *
     * Configuration, not credentials — those are `secrets`, so that a provider
     * able to keep them out of the box is given the chance to.
     */
    env?: Readonly<Record<string, string>>;
    /**
     * Credentials for processes here.
     *
     * Every provider accepts these; what differs is whether the value ends up
     * inside the box, which the sandbox then reports as `secrets`. Passing one
     * here rather than as `env` costs a provider that cannot substitute
     * nothing, and is the only way to benefit from one that can.
     */
    secrets?: readonly Secret[];
    /** Reattach to an existing sandbox by id instead of creating one. */
    reconnect?: string;
    signal?: AbortSignal;
  }): Promise<Result<Sandbox, SandboxError>>;
}
