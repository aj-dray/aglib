import type { Harness, HarnessContext, HarnessResult } from "../../harness.js";
import type { Entry, ToolCall, ToolResult } from "../../../session/entry.js";
import type { Sandbox, SandboxProcess } from "../../../sandbox/sandbox.js";
import type { Decide, ToolSpec } from "../../../tools/tool.js";
import type { JsonValue } from "../../../json.js";
import { textOf } from "../../../content.js";
import { err, ok, type Failure, type Result } from "../../../result.js";
import { createRpc, type Rpc } from "./rpc.js";

/** An agent process: argv and the environment that selects its provider and model. */
export interface AcpAgent {
  command: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** A tool server the foreign agent connects to itself. This is how it gets ours. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args?: readonly string[];
  env?: readonly { name: string; value: string }[];
}

/**
 * Something the agent lets a client change about a session.
 *
 * The protocol used to name models specifically; it now publishes a list of
 * options and gives each a category, so a client can tell a model selector
 * from a reasoning level without knowing the agent. We report them rather than
 * interpret them: the ids and the choices are the agent's, and a service that
 * mapped them onto its own three levels would be guessing at another product's
 * vocabulary.
 */
export interface AcpConfigOption {
  id: string;
  name: string;
  /** "model", "thought_level", "mode", "model_config", or whatever the agent says. */
  category: string;
  description?: string;
  current: string | boolean;
  /** Absent for a boolean option. */
  choices?: readonly { id: string; name: string }[];
}

export interface AcpHarnessOptions {
  /** Names this harness in the log and in the UI. */
  id: string;
  agent: AcpAgent;
  /**
   * Where the agent runs. Not merely where its file requests are served: the
   * process itself is started here, because a coding agent runs its own shell
   * and only delegates the calls it chooses to.
   */
  sandbox: Sandbox;
  mcpServers?: readonly AcpMcpServer[];
  /**
   * What to set before prompting, by option id — the agent's own ids, from
   * `onConfig`. The only configuration door, deliberately: an option this
   * package named would be a guess at another product's vocabulary, and one
   * that goes stale the first time an agent ships an axis nobody thought of.
   *
   * Applied only where the agent published that option and, for a select, that
   * value — otherwise the run fails naming what it does offer, rather than
   * quietly running something else.
   */
  select?: Readonly<Record<string, string | boolean>>;
  /** What the agent published. The caller persists it so a session can offer the agent's own choices. */
  onConfig?(options: readonly AcpConfigOption[]): void;
  /**
   * Applied to the agent's own tools, per call, before they run.
   *
   * The protocol carries a title and the raw arguments for these, but no
   * schema, so `spec.parameters` is `{}` and `spec.description` is the agent's
   * own title for the call. That is what we actually have.
   */
  decide?: Decide;
  /** The agent's previous session id, so this activation continues its context. */
  resume?: string;
  /** Called with the agent's session id, so the caller can persist it for the next activation. */
  onSession?(sessionId: string): void;
}

const PROTOCOL_VERSION = 1;

/**
 * The handshake, and what it claims for us.
 *
 * Two callers open a connection — a turn, and `acpOptions` — and an agent
 * decides what to offer from what the client says it can do. A second copy of
 * this is a second answer to the same question, and the two would drift.
 */
const initialize = (rpc: Rpc) =>
  rpc.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "aglib", version: "0" },
  });

/**
 * Runs a foreign coding agent over the Agent Client Protocol.
 *
 * The adapter is not a remote control. It does three things the raw protocol
 * does not: it normalises whatever the agent did into this package's entries,
 * so one durable log describes a Claude Code turn and a native-loop turn
 * identically; it puts the agent's own tools under the application's decision
 * function, one call at a time; and it hands the agent tool servers of ours, so
 * agents can dispatch and message each other.
 */
export function createAcpHarness(options: AcpHarnessOptions): Harness {
  return {
    id: options.id,
    // Its tools are its own. We gate them and we record them; we do not claim
    // to have validated arguments we never had a schema for.
    // The agent owns its context. Our entries describe what it did, and cannot
    // by themselves put it back mid-turn.
    recovery: "none",
    run: (context) => runTurn(options, context),
  };
}

/**
 * What an agent offers, before anyone has asked it anything.
 *
 * Over this protocol an agent publishes its options in the answer to
 * `session/new`, so nothing knows what a model, a mode or a reasoning level is
 * called until a session exists — and a session exists on the first prompt.
 * That left a client with a menu it could not draw until after the choice it
 * wanted to offer had already been made.
 *
 * So this opens one and asks. It spawns, initialises, opens a session, reads
 * what came back and closes: a process and a handshake, no prompt, no
 * generation, nothing billed. The session it opened is thrown away — the run
 * opens its own, exactly as it did before.
 */
export async function acpOptions(input: {
  agent: AcpAgent;
  sandbox: Sandbox;
}): Promise<Result<readonly AcpConfigOption[], Failure>> {
  const started = await input.sandbox.spawn({
    command: input.agent.command,
    cwd: input.sandbox.root,
    ...(input.agent.env ? { env: input.agent.env } : {}),
  });
  if (!started.ok) return err(started.error);

  const rpc = createRpc(started.value);
  try {
    const ready = await initialize(rpc);
    if (!ready.ok) return err(ready.error);

    const opened = await rpc.request("session/new", { cwd: input.sandbox.root, mcpServers: [] } as unknown as JsonValue);
    if (!opened.ok) return err(opened.error);
    return ok(readOptions(opened.value).options);
  } finally {
    rpc.close();
  }
}

async function runTurn(options: AcpHarnessOptions, context: HarnessContext): Promise<HarnessResult> {
  const started = await options.sandbox.spawn({
    command: options.agent.command,
    cwd: options.sandbox.root,
    ...(options.agent.env ? { env: options.agent.env } : {}),
  });
  if (!started.ok) return { status: "failed", error: started.error };

  const rpc = createRpc(started.value);
  const turn = createTurn(options, context, rpc);
  try {
    return await turn.run();
  } finally {
    rpc.close();
  }
}

/** Cumulative state for one activation. Discarded with the process that produced it. */
function createTurn(options: AcpHarnessOptions, context: HarnessContext, rpc: Rpc) {
  const sandbox = options.sandbox;
  const terminals = new Map<string, { process: SandboxProcess; output: () => string; exit: Promise<number> }>();
  const calls = new Map<string, { name: string; input: JsonValue; output?: JsonValue; failed?: boolean }>();
  let text = "";
  let sessionId = "";
  let terminalCount = 0;
  /**
   * Whether an update describes this activation, or the last one.
   *
   * `session/load` replays the whole conversation back as `session/update`
   * notifications — measured against `codex-acp`, which answers a load with the
   * user message and the agent message of every turn before it. Those are the
   * same words this log already committed when they were first said, so
   * treating them as output would append the entire history again on every
   * resumed activation, and prepend it to whatever the new turn actually says.
   * Nothing before the prompt belongs to the run the prompt starts.
   */
  let live = false;

  return { run };

  async function run(): Promise<HarnessResult> {
    serveFiles();
    serveTerminals();
    servePermission();
    rpc.onNotify("session/update", (params) => { void receive(params); });

    const ready = await initialize(rpc);
    if (!ready.ok) return { status: "failed", error: ready.error };
    const capabilities = field(ready.value, "agentCapabilities");

    const opened = await openSession(truthy(field(capabilities, "loadSession")));
    if (!opened.ok) return { status: "failed", error: opened.error };
    sessionId = opened.value;
    options.onSession?.(sessionId);

    const configured = await configure(opened.value, opened.opened ?? undefined);
    if (!configured.ok) return { status: "failed", error: configured.error };

    const cancel = () => rpc.notify("session/cancel", { sessionId });
    context.signal.addEventListener("abort", cancel, { once: true });

    // Anything the agent replayed while opening has already been dispatched:
    // one stdio stream, read in order, so a load's echo is behind us here.
    live = true;
    const answered = await rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: inputFor(context) }],
    });
    context.signal.removeEventListener("abort", cancel);
    for (const terminal of terminals.values()) terminal.process.kill();

    if (!answered.ok) return { status: "failed", error: answered.error };
    await flushText();
    return outcome(String(field(answered.value, "stopReason") ?? "end_turn"));
  }

  async function openSession(canLoad: boolean) {
    const parameters = {
      cwd: sandbox.root,
      mcpServers: (options.mcpServers ?? []).map((server) => ({
        type: "stdio", name: server.name, command: server.command,
        args: [...(server.args ?? [])], env: [...(server.env ?? [])],
      })),
    } as unknown as JsonValue;

    // The whole answer is carried out, not one field of it: what an agent
    // publishes about a session has changed shape once already.
    if (options.resume && canLoad) {
      const loaded = await rpc.request("session/load", { ...(parameters as object), sessionId: options.resume } as JsonValue);
      if (loaded.ok) return { ...ok(options.resume), opened: loaded.value };
    }
    const created = await rpc.request("session/new", parameters);
    if (!created.ok) return { ...created, opened: null };
    const id = field(created.value, "sessionId");
    if (typeof id !== "string") {
      return { ...err<Failure>({ code: "protocol", message: "The agent opened no session.", retryable: false }), opened: null };
    }
    return { ...ok(id), opened: created.value };
  }

  /**
   * Read what the agent lets us change, report it, and set what was asked for.
   *
   * Two shapes, because the protocol changed one into the other: `models` used
   * to be its own field on the session, and is now one entry in `configOptions`
   * carrying `category: "model"`. Both are read, so an agent on either version
   * is understood, and neither is required.
   *
   * A resumed session reads this from the `session/load` answer, and an agent
   * that answers a load without republishing is one whose options we do not
   * currently know. Setting one from what a previous session said would be
   * asserting a capability this connection never claimed — so a request for an
   * option that is not published fails, naming what is. Measured against
   * `claude-agent-acp`, which does republish on load.
   */
  async function configure(id: string, opened: JsonValue | undefined) {
    const { options: published, legacyModel } = readOptions(opened);
    if (published.length) options.onConfig?.(published);

    // One door, and `select` is it. There were two more — `mode`, which sent
    // `session/set_mode`, and `model`, which found whichever option the agent
    // had categorised as its selector. Both were conveniences naming an axis,
    // and naming an axis is guessing at a vocabulary that is not ours: the
    // agents measured here publish five categories between them, and no
    // shorthand was ever going to cover the next one. `session/set_config_option`
    // with `configId: "mode"` was checked against `claude-agent-acp` and does
    // what `session/set_mode` did, answering with the new state as well.
    for (const [option, value] of Object.entries(options.select ?? {})) {
      const published_ = published.find((candidate) => candidate.id === option);
      if (!published_) {
        return err<Failure>({
          code: "unsupported",
          message: `${options.id} offers no option '${option}'. It offers: ${published.map((o) => o.id).join(", ") || "none"}.`,
          retryable: false,
        });
      }
      if (published_.current === value) continue;
      if (published_.choices && !published_.choices.some((choice) => choice.id === value)) {
        return err<Failure>({
          code: "unsupported",
          message: `${options.id} does not offer '${String(value)}' for ${published_.name}. It offers: ${published_.choices.map((c) => c.id).join(", ")}.`,
          retryable: false,
        });
      }
      const legacy = published_.id === legacyModel;
      const set = await rpc.request(
        legacy ? "session/set_model" : "session/set_config_option",
        legacy
          ? { sessionId: id, modelId: value }
          : { sessionId: id, configId: published_.id, value, ...(typeof value === "boolean" ? { type: "boolean" } : {}) },
      );
      if (!set.ok) return set;
    }
    return ok(undefined);
  }

  // ---- Normalising what the agent did into entries -------------------------

  /**
   * A tool call becomes entries when it finishes, in one commit: the assistant
   * turn that asked for it, the start, and the result. Committing the pieces as
   * they arrive would leave half-states in a log whose whole purpose is that it
   * can be replayed, and a live viewer is served by `emit` instead.
   */
  async function receive(params: JsonValue): Promise<void> {
    if (!live) return;
    const update = field(params, "update");
    const kind = String(field(update, "sessionUpdate") ?? "");

    if (kind === "agent_message_chunk") {
      const chunk = String(field(field(update, "content"), "text") ?? "");
      text += chunk;
      context.emit({ type: "text.delta", text: chunk });
      return;
    }
    if (kind === "agent_thought_chunk") {
      context.emit({ type: "reasoning.delta", text: String(field(field(update, "content"), "text") ?? "") });
      return;
    }
    if (kind === "usage_update") {
      // Dropped deliberately. This protocol reports a spend figure and no token
      // counts, and `Usage` carries tokens and no money, so there is nothing
      // here that could be recorded without inventing it. An agent behind this
      // harness is unaccounted for, and the capability table says so.
      return;
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return;

    const callId = String(field(update, "toolCallId") ?? "");
    if (!callId) return;
    const existing = calls.get(callId) ?? { name: "", input: null };
    const name = nameOf(update);
    const raw = field(update, "rawInput");
    calls.set(callId, {
      name: name || existing.name || "tool",
      input: raw === undefined || raw === null ? existing.input : raw,
      ...(existing.output === undefined ? {} : { output: existing.output }),
    });
    context.emit({ type: "tool.progress", callId, data: update ?? null });

    const status = String(field(update, "status") ?? "");
    if (status !== "completed" && status !== "failed") return;

    const call = calls.get(callId)!;
    calls.delete(callId);
    const result = resultOf(update, status === "failed");
    await context.commit(assistantAsking(call, callId).concat(
      { type: "tool.started", runId: context.runId, callId },
      { type: "tool.finished", runId: context.runId, callId, result },
    ));
  }

  function assistantAsking(call: { name: string; input: JsonValue }, callId: string): Entry[] {
    const asked: ToolCall = { callId, name: call.name, arguments: JSON.stringify(call.input ?? {}) };
    const said = text;
    text = "";
    return [{ type: "assistant", runId: context.runId, content: said, calls: [asked] }];
  }

  async function flushText(): Promise<void> {
    if (!text) return;
    const said = text;
    text = "";
    await context.commit([{ type: "assistant", runId: context.runId, content: said }]);
  }

  function outcome(stopReason: string): HarnessResult {
    if (stopReason === "cancelled") return { status: "cancelled" };
    if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      return {
        status: "failed",
        error: { code: "limit", message: `${options.id} stopped: ${stopReason}.`, retryable: false },
      };
    }
    return { status: "completed", output: lastSaid(context) };
  }

  // ---- Serving the agent's requests from the sandbox ----------------------

  function serveFiles(): void {
    rpc.on("fs/read_text_file", async (params) => {
      const read = await sandbox.readFile({ path: String(field(params, "path") ?? "") });
      return read.ok ? ok({ content: read.value }) : read;
    });
    rpc.on("fs/write_text_file", async (params) => {
      const written = await sandbox.writeFile({
        path: String(field(params, "path") ?? ""),
        content: String(field(params, "content") ?? ""),
      });
      return written.ok ? ok(null) : written;
    });
  }

  /**
   * The protocol's terminal, served from the sandbox.
   *
   * Worth knowing before relying on it: an agent uses this only if it chooses
   * to, and the one measured here does not. `@agentclientprotocol/claude-agent-acp`
   * calls exactly four client methods — `fs/read_text_file`,
   * `fs/write_text_file`, `session/request_permission`, `session/update` — and
   * emits a terminal block for display while running the command itself. So
   * these handlers are correct and, for that agent, never reached. Containment
   * comes from starting the agent inside the sandbox, not from serving this.
   */
  function serveTerminals(): void {
    rpc.on("terminal/create", async (params) => {
      const argv = ["/bin/sh", "-lc", [field(params, "command"), ...(asArray(field(params, "args")))].filter(Boolean).join(" ")];
      const cwd = field(params, "cwd");
      const spawned = await sandbox.spawn({
        command: argv,
        ...(typeof cwd === "string" ? { cwd } : {}),
      });
      if (!spawned.ok) return spawned;
      const id = `terminal-${++terminalCount}`;
      let collected = "";
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          collected += decoder.decode(chunk, { stream: true });
        }
      };
      void drain(spawned.value.stdout);
      void drain(spawned.value.stderr);
      terminals.set(id, { process: spawned.value, output: () => collected, exit: spawned.value.exited });
      return ok({ terminalId: id });
    });

    rpc.on("terminal/output", async (params) => {
      const terminal = terminals.get(String(field(params, "terminalId") ?? ""));
      if (!terminal) return err<Failure>({ code: "not-found", message: "No such terminal.", retryable: false });
      const finished = await Promise.race([terminal.exit, Promise.resolve(undefined)]);
      return ok({
        output: terminal.output(),
        truncated: false,
        ...(finished === undefined ? {} : { exitStatus: { exitCode: finished, signal: null } }),
      });
    });

    rpc.on("terminal/wait_for_exit", async (params) => {
      const terminal = terminals.get(String(field(params, "terminalId") ?? ""));
      if (!terminal) return err<Failure>({ code: "not-found", message: "No such terminal.", retryable: false });
      return ok({ exitCode: await terminal.exit, signal: null });
    });

    rpc.on("terminal/kill", async (params) => {
      terminals.get(String(field(params, "terminalId") ?? ""))?.process.kill();
      return ok(null);
    });

    rpc.on("terminal/release", async (params) => {
      const id = String(field(params, "terminalId") ?? "");
      terminals.get(id)?.process.kill();
      terminals.delete(id);
      return ok(null);
    });
  }

  /**
   * The agent's own tools, one call at a time, through the application's rule.
   *
   * The agent is blocked on this reply, so the answer is yes or no and nothing
   * else. That constraint is why the permission model has two outcomes rather
   * than three: a rule that could park a call would be honourable in our own
   * loop and unhonourable here, which is the ragged surface the two-outcome
   * shape avoids.
   */
  function servePermission(): void {
    rpc.on("session/request_permission", async (params) => {
      const call = field(params, "toolCall");
      const callId = String(field(call, "toolCallId") ?? "");
      const options_ = asArray(field(params, "options"));
      const pick = (...kinds: string[]) => {
        for (const kind of kinds) {
          const found = options_.find((option) => String(field(option, "kind") ?? "") === kind);
          if (found) return String(field(found, "optionId") ?? "");
        }
        return undefined;
      };
      const selected = (optionId: string | undefined) =>
        optionId === undefined
          ? ok({ outcome: { outcome: "cancelled" } })
          : ok({ outcome: { outcome: "selected", optionId } });

      if (!options.decide) return selected(pick("allow_once", "allow_always"));

      const spec: ToolSpec = {
        name: nameOf(call) || "tool",
        description: String(field(call, "title") ?? ""),
        parameters: {},
      };
      const decided = await options.decide({
        tool: spec,
        input: (field(call, "rawInput") ?? {}) as JsonValue,
        sessionId: context.sessionId,
        runId: context.runId,
        callId,
      });
      if (decided.action === "execute") return selected(pick("allow_once", "allow_always"));
      return selected(pick("reject_once", "reject_always"));
    });
  }
}

/**
 * What the agent published, from either shape the protocol has used.
 *
 * `configOptions` is current. `models` is what the same fact was called before
 * it was generalised, and is normalised into an option categorised "model" so
 * a caller never has to know which version answered.
 */
function readOptions(
  opened: JsonValue | undefined,
): { options: readonly AcpConfigOption[]; legacyModel: string | null } {
  const found: AcpConfigOption[] = [];

  for (const raw of asArray(field(opened, "configOptions"))) {
    const id = field(raw, "id");
    if (typeof id !== "string") continue;
    const choices = asArray(field(raw, "options")).flatMap((choice) => {
      const value = field(choice, "id") ?? field(choice, "value");
      return typeof value === "string"
        ? [{ id: value, name: String(field(choice, "name") ?? value) }]
        : [];
    });
    const current = field(raw, "currentValue");
    found.push({
      id,
      name: String(field(raw, "name") ?? id),
      category: String(field(raw, "category") ?? ""),
      ...(typeof field(raw, "description") === "string" ? { description: String(field(raw, "description")) } : {}),
      current: typeof current === "boolean" ? current : String(current ?? ""),
      ...(choices.length ? { choices } : {}),
    });
  }

  const models = field(opened, "models");
  const available = asArray(field(models, "availableModels"));
  if (available.length && !found.some((option) => option.category === "model")) {
    found.push({
      id: "model",
      name: "Model",
      category: "model",
      current: String(field(models, "currentModelId") ?? ""),
      choices: available.flatMap((model) => {
        const id = field(model, "modelId");
        return typeof id === "string" ? [{ id, name: String(field(model, "name") ?? id) }] : [];
      }),
    });
    // An agent that published its models this way answers `session/set_model`
    // and has never heard of `session/set_config_option`. Both shapes carry
    // choices, so the option alone cannot say which method it takes: where it
    // was read is the only thing that distinguishes them.
    return { options: found, legacyModel: "model" };
  }
  return { options: found, legacyModel: null };
}

// ---- Reading the protocol's loosely-typed payloads --------------------------

const field = (value: JsonValue | undefined, key: string): JsonValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)[key]
    : undefined;

const asArray = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

const truthy = (value: JsonValue | undefined): boolean => value === true;

/** The agent's real tool name when it publishes one, else the protocol's coarse kind. */
const nameOf = (update: JsonValue | undefined): string => {
  const meta = field(update, "_meta");
  for (const vendor of Object.values((meta ?? {}) as Record<string, JsonValue>)) {
    const named = field(vendor, "toolName");
    if (typeof named === "string") return named;
  }
  return String(field(update, "kind") ?? "");
};

function resultOf(update: JsonValue | undefined, failed: boolean): ToolResult {
  const raw = field(update, "rawOutput");
  const blocks = asArray(field(update, "content"))
    .map((entry) => field(field(entry, "content"), "text"))
    .filter((value): value is string => typeof value === "string");
  const content = blocks.length ? blocks.join("\n") : typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  return {
    content,
    ...(raw === undefined ? {} : { details: raw }),
    ...(failed ? { isError: true } : {}),
  };
}

/** This activation's input: the entries `runAgent` committed before calling us. */
const inputFor = (context: HarnessContext): string =>
  context.entries()
    .filter((entry) => entry.type === "run.started" && entry.runId === context.runId)
    .map((entry) => textOf((entry as Extract<Entry, { type: "run.started" }>).input))
    .join("\n\n");

/** The agent's final word, read back from the log it was just committed to. */
function lastSaid(context: HarnessContext): string {
  const entries = context.entries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "assistant" && entry.runId === context.runId) return textOf(entry.content);
  }
  return "";
}

