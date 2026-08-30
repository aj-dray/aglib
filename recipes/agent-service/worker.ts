/**
 * A worker. Take the next runnable session, run it, commit.
 *
 * One activation per session, and two mechanisms doing two jobs. The claim
 * taken by `store.next` is exclusion: it stops a second worker starting a
 * second activation of a session already running, and it renews on every write
 * that activation makes, so a long turn is not taken out from under itself.
 * `expectedSeq` is correctness: whatever happens, two writers cannot interleave
 * at one position. There is still no fencing token and no renewal subsystem —
 * a claim expires on its own, and a worker that died has stopped writing.
 */
import { runAgent, type Decide } from "aglib";
import type { JsonValue } from "aglib";
import type { Store } from "aglib/store";
import type { Sandbox, Secret } from "aglib/sandbox";
import type { Harness } from "aglib/harness";
import { createNativeHarness } from "aglib/harness";
import { createAcpHarness, type AcpConfigOption } from "aglib/harness/adapters/acp";
import { harnessFor, type SessionRecord } from "./harnesses.ts";
import { baseEnvironment, environmentFor } from "./credentials.ts";
import { createClaudeCodeHarness } from "./claude-code.ts";
import { openSandbox } from "./sandbox.ts";
import { chooseModel, priceOf } from "./model.ts";
import { serviceTools, type Running } from "./tools.ts";
import { codingAgent, orientation } from "./orientation.ts";
import { sandboxTools } from "./sandbox-tools.ts";

/**
 * Every agent's own subagent tool, refused.
 *
 * This is the substitution the service exists to make. A native subagent runs
 * privately inside one session: it cannot be listed, addressed or interrupted,
 * and it disappears with the turn that made it. Refusing it by name, through
 * the one decision function every harness shares, needs no per-agent
 * configuration and works the same for all five.
 */
const nativeSubagents = new Set([
  "task", "agent", "subagent", "spawn_agent", "dispatch_agent", "new_task", "run_agent",
]);

const decide: Decide = (call) =>
  nativeSubagents.has(call.tool.name.toLowerCase())
    ? {
        action: "reject",
        message:
          "This agent's own subagent tool is disabled here. Use `dispatch` to start an agent with its own session, " +
          "sandbox and model — visible in the service, and something you can message or interrupt — or `delegate` " +
          "for one bounded question answered in place.",
      }
    : { action: "execute" };

export async function work(input: {
  store: Store;
  running: Running;
  serviceUrl: string;
  signal: AbortSignal;
}): Promise<void> {
  const { store, running, signal } = input;

  // A wake is a request to look again, never a description of what to do — so a
  // spurious one costs a query and a missed one costs the heartbeat. Held for
  // the life of the worker rather than opened while idle, because a change that
  // landed between `next` returning nothing and a watch being registered would
  // otherwise wait out the whole heartbeat.
  let stirred = false;
  let wake: (() => void) | undefined;
  const unwatch = store.watch?.((change) => {
    if (!change.runnable) return;
    stirred = true;
    wake?.();
  }) ?? (() => {});

  try {
    while (!signal.aborted) {
      // Cleared before asking, so anything landing from here on is still waiting
      // for this worker when it finds nothing.
      stirred = false;
      const next = await store.next({ signal });
      // Nothing has been asked for. The other question is what was being worked
      // when a process stopped existing: an activation whose worker was killed is
      // owed to nobody, so `next` cannot see it and it waits for a stranger to
      // speak to the session. `interrupted` is that question, and the run it hands
      // back is continued rather than begun — its input is already on the log,
      // and so is the tool call that already had its effect.
      //
      // Compromise, accepted: a session whose harness cannot restart from
      // history is claimed here too, and this worker provisions a sandbox
      // before `runAgent` refuses and ends the run. That costs one machine,
      // once, for such a session — not one per claim window, because the
      // refusal closes the activation. Avoiding even that would need a second
      // notion of recoverability out here, beside the `resume` control the
      // capability table already has for a different fact.
      const interrupted = next.ok && !next.value ? await store.interrupted({ signal }) : undefined;
      const claimed = next.ok
        ? next.value ?? (interrupted?.ok ? interrupted.value : undefined)
        : undefined;
      if (!claimed) { await quiet(); continue; }

      const { sessionId, seq, pending, metadata } = claimed;
      // `metadata` is this application's, not the library's. aglib stored it and
      // returned it, and never looked inside.
      const record = (metadata ?? {}) as unknown as SessionRecord;

      // Configuration is checked before anything is provisioned. A missing
      // credential is not a reason to have paid for a sandbox.
      const ready = configured(record);
      if (!ready.ok) { await recordFailure(store, sessionId, seq, pending.length, ready.message); continue; }

      // The box is made knowing what will run in it. A provider that can hold a
      // credential outside the box and put it in at egress has to be told
      // before the box exists, because what it gives the box is a reference.
      const sandbox = await openSandbox({
        sessionId,
        secrets: ready.secrets,
        ...(record.sandboxId ? { reconnect: record.sandboxId } : {}),
      });
      if (!sandbox.ok) { await recordFailure(store, sessionId, seq, pending.length, sandbox.error.message); continue; }

      const built = buildHarness({
        record, sandbox: sandbox.value, sessionId, serviceUrl: input.serviceUrl, store, running,
        connected: ready,
      });
      if (!built.ok) {
        await recordFailure(store, sessionId, seq, pending.length, built.message);
        await sandbox.value.close();
        continue;
      }

      const adapter = harnessFor(record.harness)?.adapter;

      // The native loop brings no prompt of its own, so what a coding agent is
      // has to come from here. Every vendor harness arrives with thousands of
      // words of its own and ours on top of those would be arguing with them.
      const instructions = adapter === "native"
        ? `${codingAgent}\n\n${orientation(sessionId)}`
        : orientation(sessionId);

      // Orientation is prepended to the first message only where it has nowhere
      // better to go: the protocol carries no system prompt, so an agent behind
      // it is told this way instead. Everything else already has the words, and
      // repeating them would be the same words twice.
      const needsPreamble = adapter === "acp";

      const control = new AbortController();
      running.set(sessionId, control);
      try {
        const run = runAgent({
          agent: {
            id: `agent-${record.harness ?? "native"}`,
            version: "1",
            instructions,
            harness: built.harness,
            tools: built.harness.toolUse === "application" ? [...serviceTools({ store, sessionId, running }), ...sandboxTools(sandbox.value)] : [],
            decide,
            // A finished agent tells whoever dispatched it, in the same write
            // that records its own completion. It never waits for a reply, which
            // is what stops a tree of agents deadlocking on a finite pool.
            finished: ({ outcome, output }) =>
              record.parentSessionId
                ? [{
                    sessionId: record.parentSessionId,
                    input: `Session ${sessionId} ${outcome}.\n\n${String(output)}`,
                    from: { kind: "session", id: sessionId },
                    priority: "next" as const,
                  }]
                : [],
          },
          store,
          // The session, the position, and the deliveries to consume, as one
          // value that arrived together. A claim with an empty queue is a
          // resumption: the activation continues the committed log rather than
          // opening a second beginning on top of the first.
          claim: claimed,
          ...(needsPreamble && seq === 0 ? { input: instructions } : {}),
          signal: control.signal,
        });

        // Nothing consumes the update stream here: a worker is headless, and the
        // UI reads committed entries instead. The stream is bounded and drops its
        // oldest, so not draining it costs a fixed amount rather than a run's
        // whole output.
        const finished = await run.result;
        // What it consumed comes from the run, on every outcome. What that cost
        // is priced here, from the log, because the rates are this service's —
        // and a generation it has no rate for is counted rather than summed as
        // free, which is a figure quietly short.
        const { usage } = finished;
        const { usd, unpriced } = await spentOn(store, sessionId);
        console.log(
          `session ${sessionId} ${finished.status}`,
          `in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0}`,
          `usd=${usd.toFixed(4)}${unpriced ? ` (+${unpriced} unpriced)` : ""}`,
        );
      } catch (error) {
        // One session's failure is one session's. `main` awaits every worker
        // together, so an exception escaping here used to take down the service —
        // which is exactly what an interrupted run did before the adapters
        // returned a typed cancellation.
        console.error(`session ${sessionId} failed:`, error);
      } finally {
        running.delete(sessionId);
        await remember(store, sessionId, built.learned());
        await sandbox.value.close();
      }
    }
  } finally {
    unwatch();
  }

  /**
   * Wait for something to change.
   *
   * With a feed this is the heartbeat behind it — the backstop for a wake that
   * was never delivered, or one from a process this store does not see. Without
   * one it is the poll it always was, and the interval is the whole of a
   * message's latency.
   */
  function quiet(): Promise<void> {
    if (stirred) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wake = undefined;
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, store.watch ? HEARTBEAT_MS : POLL_MS);
      wake = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

/**
 * What this session has cost, priced from its log.
 *
 * The library reports counts and no money and holds no ceiling over them: rates
 * are the deployment's, and so is what to do when a run gets expensive. This is
 * where both live. A generation with no rate is counted, never summed as zero —
 * a total that is quietly short is worse than one that says where it stopped.
 */
async function spentOn(store: Store, sessionId: string): Promise<{ usd: number; unpriced: number }> {
  const read = await store.read({ sessionId });
  if (!read.ok) return { usd: 0, unpriced: 0 };
  let usd = 0;
  let unpriced = 0;
  for (const entry of read.value.entries) {
    if (entry.type !== "assistant" || !entry.usage) continue;
    const cost = priceOf({
      ...(entry.generation?.model ? { model: entry.generation.model } : {}),
      usage: entry.usage,
    });
    if (cost === undefined) unpriced += 1;
    else usd += cost;
  }
  return { usd, unpriced };
}

/** How long a worker with a feed waits before looking anyway. */
const HEARTBEAT_MS = 30_000;
/** How often a worker with no feed asks. This interval is a message's latency. */
const POLL_MS = 500;

/**
 * Everything about a session that can be judged without provisioning anything.
 *
 * Split out because the order mattered: the sandbox used to be created first,
 * so a session that could never run — no credential, no such agent — still
 * cost a container every time a worker looked at it.
 */
function configured(
  record: SessionRecord,
): { ok: true; env: Record<string, string>; secrets: readonly Secret[] } | { ok: false; message: string } {
  const harness = harnessFor(record.harness);
  if (!harness) return { ok: false, message: `No harness named '${record.harness}'.` };
  if (harness.unavailable) return { ok: false, message: harness.unavailable };
  if (harness.adapter === "native") {
    const model = chooseModel(record);
    if (!model.ok) return { ok: false, message: model.error.message };
  }
  const connected = environmentFor([harness.credential]);
  // Resolved once and carried, not resolved again where it is used: reading a
  // credential twice is two chances to disagree about whether it is there.
  return connected.ok
    ? { ok: true, env: connected.env, secrets: connected.secrets }
    : { ok: false, message: notConnected(connected.missing) };
}

/**
 * "Claude here, Codex there" is a field on the session, resolved to a harness.
 *
 * The five external agents are one adapter, because they speak one protocol.
 * They declare `toolUse: "harness"` — they run their own tools, which this
 * service gates and records but never claims to have validated.
 */
function buildHarness(input: {
  record: SessionRecord;
  sandbox: Sandbox;
  sessionId: string;
  serviceUrl: string;
  store: Store;
  running: Running;
  /** Already resolved, before the sandbox was made, and the same values it was made with. */
  connected: { env: Record<string, string>; secrets: readonly Secret[] };
}): { ok: true; harness: Harness; learned(): Partial<SessionRecord> } | { ok: false; message: string } {
  const { record, sandbox, sessionId, connected } = input;
  const configuration = harnessFor(record.harness);
  if (!configuration) return { ok: false, message: `No harness named '${record.harness}'.` };

  const model = record.model ?? configuration.defaultModel;

  if (configuration.adapter === "native") {
    const chosen = chooseModel(record);
    if (!chosen.ok) return { ok: false, message: chosen.error.message };
    return {
      ok: true,
      harness: createNativeHarness({
        model: chosen.value,
        // How hard to think is a knob over each call, so it rides the loop
        // rather than the model.
        ...(record.effort ? { effort: record.effort } : {}),
        // Named, because not naming one is not "no limit": the provider
        // reserves the model's whole ceiling.
        maxOutputTokens: 8192,
      }),
      learned: () => ({ sandboxId: sandbox.id }),
    };
  }

  // Cleaned of every vendor variable, then given back exactly what this run is
  // entitled to: the paths its CLI needs, and the configuration its row asks
  // for. No credential — where the agent runs decides who holds that.
  const environment = {
    ...baseEnvironment(),
    ...connected.env,
    ...(configuration.environment?.({
      ...(model ? { model } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
    }) ?? {}),
    // The SDK starts Claude Code in this process, so this process is where its
    // credential has to be. The protocol adapter starts its agent in the box
    // with `sandbox.spawn`, and the box was made holding the same secrets — as
    // a reference where the provider can manage that, and `sandbox.secrets`
    // says which happened. Putting the value here too would put it back on the
    // machine the box exists to keep it off.
    ...(configuration.adapter === "sdk"
      ? Object.fromEntries(connected.secrets.map((secret) => [secret.env, secret.value]))
      : {}),
  };

  let agentSessionId = record.acpSessionId;
  let published: SessionRecord["options"];
  const remember = (): Partial<SessionRecord> => ({
    sandboxId: sandbox.id,
    ...(agentSessionId ? { acpSessionId: agentSessionId } : {}),
    ...(published ? { options: published } : {}),
  });

  if (configuration.adapter === "sdk") {
    return {
      ok: true,
      harness: createClaudeCodeHarness({
        store: input.store, running: input.running, sessionId, sandbox,
        // Its own hands reach this machine, so they are honest only when the
        // sandbox IS this machine. Anywhere else every built-in is taken away
        // and sandbox-backed tools replace them.
        hands: sandbox.isolation === "none" ? "own" : "sandbox",
        env: environment,
        decide,
        instructions: orientation(sessionId),
        ...(model ? { model } : {}),
        ...(record.effort ? { effort: record.effort } : {}),
        ...(agentSessionId ? { resume: agentSessionId } : {}),
        onSession: (id: string) => { agentSessionId = id; },
      }),
      learned: remember,
    };
  }

  if (!configuration.command) return { ok: false, message: `${configuration.title} names no command to start.` };
  return {
    ok: true,
    harness: createAcpHarness({
      id: configuration.id,
      // Started inside the sandbox, because its own tools cannot be removed.
      agent: { command: configuration.command, env: environment },
      sandbox,
      ...(configuration.mode ? { mode: configuration.mode } : {}),
      // Only over the protocol, and only where the agent published a selector
      // for it. A harness whose row names its models sets them by environment.
      ...(configuration.models.length === 0 && model ? { model } : {}),
      ...(record.select ? { select: record.select } : {}),
      onConfig: (options: readonly AcpConfigOption[]) => { published = options; },
      decide,
      mcpServers: [{
        name: "agent-service",
        command: process.execPath,
        args: [new URL("./mcp.ts", import.meta.url).pathname],
        env: [
          { name: "AGLIB_SERVICE", value: input.serviceUrl },
          { name: "AGLIB_SESSION", value: sessionId },
        ],
      }],
      ...(agentSessionId ? { resume: agentSessionId } : {}),
      onSession: (id: string) => { agentSessionId = id; },
    }),
    learned: remember,
  };
}

/** Persist what this activation discovered, so the next one continues rather than restarts. */
async function remember(store: Store, sessionId: string, learned: Partial<SessionRecord>): Promise<void> {
  const read = await store.read({ sessionId, afterSeq: Number.MAX_SAFE_INTEGER });
  if (!read.ok) return;
  const current = (read.value.metadata ?? {}) as unknown as Record<string, unknown>;
  if (Object.entries(learned).every(([key, value]) => current[key] === value)) return;
  await store.append({
    sessionId, expectedSeq: read.value.seq, entries: [], metadata: learned as unknown as JsonValue,
  });
}

/**
 * Record an activation that never started, and consume what it was given.
 *
 * `takePending` is the whole of it. Without it the input stays queued, the
 * session stays runnable, and a worker retries a permanent failure as fast as
 * it can — which is what happened: two sessions missing a credential wrote
 * 1.39 million entries between them overnight, and every pass through the loop
 * had already created a sandbox. A delivery is consumed by the attempt, not by
 * the attempt succeeding; anything wanting a retry enqueues one deliberately.
 */
async function recordFailure(
  store: Store, sessionId: string, seq: number, taken: number, message: string,
): Promise<void> {
  await store.append({
    sessionId, expectedSeq: seq, takePending: taken,
    entries: [{
      type: "run.finished", runId: crypto.randomUUID(), outcome: "failed",
      error: { code: "unavailable", message, retryable: false },
    }],
  });
}

const notConnected = (missing: readonly string[]): string =>
  `Not connected to ${missing.join(" and ")}. Add ${missing.length > 1 ? "them" : "it"} in the service's connections.`;

/**
 * Wait, or stop waiting.
 *
 * `once` removes the listener when it fires, and not when the timer fires
 * first — which is the ordinary case, twice a second, for as long as the
 * service is quiet. The listener has to be taken off by hand.
 */

