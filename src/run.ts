import type { Agent, AgentRun, Arrival, RunAgentOptions, RunResult } from "./agent.js";
import type { Failure } from "./result.js";
import type { HarnessContext, HarnessResult, Update } from "./harness/harness.js";
import type { Delivery, Store, StoreConflict, StoreError } from "./store/store.js";
import type { Content } from "./content.js";
import type { Entry, Stored, Usage } from "./session/entry.js";
import { err } from "./result.js";
import { createLog } from "./session/log.js";
import { toMessages } from "./session/messages.js";
import { createExecutor } from "./tools/execute.js";

/**
 * Start an agent on a session.
 *
 * Without a store the log lives in memory and the session is ephemeral; with
 * one, every commit is durable before the next turn is built. The agent
 * definition is identical either way — durability is a composition choice, not
 * a different program.
 */
export function runAgent(options: RunAgentOptions): AgentRun {
  // A claim names its own session; a caller sending into a new one names none.
  const hooks = options.agent.hooks ?? [];
  if (new Set(hooks.map(hook => hook.name)).size !== hooks.length || hooks.some(hook => !hook.name)) {
    throw new Error("Lifecycle hook names must be non-empty and unique.");
  }
  const claim = options.claim;
  const sessionId = claim?.sessionId ?? options.sessionId ?? crypto.randomUUID();
  const controller = new AbortController();
  // Composed rather than forwarded. `addEventListener("abort", …)` never fires
  // on a signal that has already aborted, so a caller who gave up before
  // calling got a full run anyway; and a listener added per run to a signal
  // that outlives it is a leak the run cannot clean up.
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  const updates = createChannel<Update>();
  const result = execute();

  return {
    result,
    cancel: () => controller.abort(),
    [Symbol.asyncIterator]: () => updates.iterator(),
  };

  async function execute(): Promise<RunResult> {
    // What this activation consumed. Summed from the `assistant` entries it
    // commits rather than reported by the harness, so one answer serves a loop
    // we own and a loop we do not — and so a run that failed still says what it
    // burned on the way there.
    const usage: Usage = {};
    let hookContext: HarnessContext | undefined;
    let result: RunResult | undefined;
    let unwatch: (() => void) | undefined;
    let clearInputWait: (() => void) | undefined;

    try {
      const { agent, store } = options;
      const restored = store ? await open(store, sessionId, agent, options.key) : undefined;
      if (restored && !restored.ok) {
        return {
          status: "failed", error: restored.error,
          seq: positionOf(restored.error, 0), usage,
        };
      }
      // The store's own position, not the last entry's. They agree only while
      // nothing has ever been folded away, and the store is the one that knows.
      const log = createLog(restored?.value.entries ?? [], restored?.value.seq ?? 0);
      const stopping = (error: Failure): RunResult => (result = { status: "failed", error, seq: log.seq, usage });

      // A claim was read at a position. If the session has moved since, this
      // worker lost, and the deliveries it was carrying are still where it
      // found them.
      if (claim && claim.seq !== log.seq) {
        return stopping({ code: "conflict", message: `Session is at ${log.seq}, not ${claim.seq}`, retryable: true });
      }

      // A ceiling on money needs something that can count it. Refused here
      // rather than silently ignored, because a limit that is declared and not
      // enforced is the most expensive kind of nothing.

      // The activation still open on this log, if one is. It decides three
      // things below: whether there is anything to resume, which run a
      // resumption continues, and which run a fresh activation supersedes.
      const interrupted = openRunId(log.entries);

      // What this run is adding, then what was waiting. A claim's deliveries
      // are named so the log records who each came from; anything the worker
      // supplies itself leads, because the only thing that ever does is
      // orientation for a harness with nowhere else to put it.
      const arrivals: readonly Arrival[] = [
        ...arrivalsOf(options.input),
        ...(claim?.pending ?? []).map((delivery): Arrival => ({
          input: delivery.input,
          ...(delivery.from ? { from: delivery.from } : {}),
        })),
      ];

      // A resumption continues the run it was handed, under that run's id. A
      // fresh id would leave the log holding a `run.started` nothing closes and
      // a `run.finished` nothing opened — a pair that only the store's
      // type-based rule saves, and that anything grouping entries by run reads
      // as broken. A resumption without an interrupted run is refused below.
      const runId = arrivals.length || !interrupted ? crypto.randomUUID() : interrupted;

      // The ceiling has one owner, and it is here rather than in a harness.
      // Counting committed entries is the only way to bound a harness that owns
      // its own loop — which is most of them — so a limit declared on the agent
      // holds for every one instead of only for ours.
      const limits = agent.limits;
      let stopped: Failure | undefined;
      let turns = 0;
      let toolCalls = 0;
      const generations = new Set<string>();

      function exceeded(): Failure | undefined {
        if (!limits) return undefined;
        if (limits.maxTurns !== undefined && turns >= limits.maxTurns) {
          return { code: "turn-limit", message: `Stopped after ${turns} turns.`, retryable: false };
        }
        if (limits.maxToolCalls !== undefined && toolCalls >= limits.maxToolCalls) {
          return { code: "tool-call-limit", message: `Stopped after ${toolCalls} tool calls.`, retryable: false };
        }
        // Checked where work is recorded rather than on a timer: a deadline
        // stops the next piece of work, it does not interrupt one mid-flight.
        if (limits.deadline !== undefined && Date.now() >= Date.parse(limits.deadline)) {
          return { code: "deadline", message: `Stopped at the deadline of ${limits.deadline}.`, retryable: false };
        }
        return undefined;
      }

      // How many deliveries the next write takes off this session's own queue:
      // what the claim was carrying, and afterwards whatever `drain` folded in.
      // Cleared by the write that lands, because the input is gone once the
      // entries carrying it are durable, and not before.
      let take = claim?.pending.length ?? 0;

      async function commit(entries: readonly Entry[], deliveries: readonly Delivery[] = []): Promise<void> {
        if (!entries.length && !deliveries.length) return;
        // Counted before the write, not after: the tokens were consumed whether
        // or not this entry wins the compare-and-swap, and a run that reports
        // nothing after paying for a generation is the opposite of what
        // `RunResult.usage` promises.
        for (const entry of entries) {
          if (entry.type === "assistant" && entry.usage) accumulate(usage, entry.usage);
        }

        if (store) {
          const written = await store.append({
            sessionId, expectedSeq: log.seq, entries,
            ...(deliveries.length ? { enqueue: deliveries } : {}),
            ...(take ? { takePending: take } : {}),
          });
          if (!written.ok) throw new CommitFailed(written.error, positionOf(written.error, log.seq));
          take = 0;
        }
        for (const stored of log.append(entries)) updates.push({ type: "entry", entry: stored });

        if (!stopped) {
          for (const entry of entries) {
            if (entry.type === "assistant") {
              const id = entry.generation?.id;
              // A provider may commit a completed asynchronous call before
              // the generation itself ends. It is recovery state, not another
              // turn and not yet the boundary at which a turn ceiling applies.
              if (!entry.generation || entry.generation.endedAt) {
                if (!id || !generations.has(id)) turns += 1;
                if (id) generations.add(id);
              }
            }
            // `tool.finished`, not `tool.started`: the start is committed before
            // the batch executes, so counting it there cancelled the very batch
            // that reached the ceiling — `maxToolCalls: 1` ran no tools at all,
            // and said it had stopped after one.
            if (entry.type === "tool.finished") toolCalls += 1;
          }
          stopped = exceeded();
          if (stopped) controller.abort();
        }
      }

      let inputWake = false;
      let wakePromise: Promise<void> | undefined;
      let resolveWake: (() => void) | undefined;
      const wake = () => {
        inputWake = true;
        resolveWake?.();
        resolveWake = undefined;
        wakePromise = undefined;
      };
      if (store?.watch) {
        unwatch = store.watch((change) => {
          if (change.sessionId !== sessionId || !change.runnable) return;
          wake();
        });
      }
      signal.addEventListener("abort", wake);
      clearInputWait = () => signal.removeEventListener("abort", wake);

      async function waitForInput(): Promise<void> {
        if (!store || signal.aborted) return;
        if (inputWake) { inputWake = false; return; }
        if (!store.watch) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          return;
        }
        wakePromise ??= new Promise<void>((resolve) => { resolveWake = resolve; });
        await wakePromise;
        inputWake = false;
      }

      // Input that arrived while this activation was running, taken from the
      // front of the queue and committed as part of it. `takePending` removes
      // exactly what was committed, in the same write, so losing the position
      // loses the turn and never the messages.
      async function drain(): Promise<number> {
        if (!store) return 0;
        // Nothing is folded into an activation that is over. Draining here
        // committed the waiting deliveries and took them off the queue, and the
        // loop then ended — leaving a peer's message answered by nobody and
        // invisible to `next` (nothing pending) and to `interrupted` (no open run),
        // which is the trap this whole path exists to close.
        if (signal.aborted) return 0;
        const current = await store.read({ sessionId, afterSeq: log.seq });
        if (!current.ok || !current.value.pending.length) return 0;
        // Only `turn` asks to join this activation. The queue is ordered and
        // consumption is a prefix, so a later delivery cannot jump over one
        // explicitly left for the next activation.
        const boundary = current.value.pending.findIndex((delivery) => delivery.priority !== "turn");
        const waiting = current.value.pending.slice(0, boundary < 0 ? current.value.pending.length : boundary);
        if (!waiting.length) return 0;
        take = waiting.length;
        await commit(waiting.map((delivery): Entry => ({
          type: "run.started", runId, input: delivery.input,
          ...(delivery.from ? { from: delivery.from } : {}),
        })));
        return waiting.length;
      }

      const executor = agent.tools?.length
        ? createExecutor({
            tools: agent.tools,
            ...(agent.decide ? { decide: agent.decide } : {}),
            sessionId, runId,
            report: (callId, data) => updates.push({ type: "tool.progress", callId, data }),
          })
        : undefined;

      if (!arrivals.length) {
        // An open run is what a resumption continues. Without one there is
        // nothing half-done here: a closed log would otherwise take a second
        // `run.finished` with no beginning to match it.
        if (!interrupted) {
          return stopping({
            code: "nothing-to-resume",
            message: "An activation with no input continues an interrupted run, and this session has none open.",
            retryable: false,
          });
        }
        if (agent.harness.recovery !== "history") {
          // Asked to continue a log this harness cannot read. The interrupted
          // run is ended rather than left open, because nothing else will
          // continue it either — the harness is a property of the session — and
          // a run that stays open is handed back by `interrupted` every window,
          // for ever. A worker that provisions anything before it runs pays for
          // that each time round.
          const failure: Failure = {
            code: "no-recovery",
            message: `The ${agent.harness.id} harness cannot restart from history, so this activation cannot be continued.`,
            retryable: false,
          };
          stopped = failure;
        }
      }

      // An interrupted predecessor is ended before a new activation begins over
      // it, so one session never holds two open runs. Only on a claim: the
      // store established there that nothing else is running, where a bare
      // `sessionId` establishes nothing and the run may still be live.
      if (arrivals.length && interrupted && claim) {
        await commit([{
          type: "run.finished", runId: interrupted, outcome: "cancelled",
          error: {
            code: "superseded",
            message: "This activation was interrupted, and a later one began over it.",
            retryable: false,
          },
        }]);
      }

      // Nothing opens a resumption. A `run.started` recording input nobody sent
      // would be a second beginning for one conversation; the loop reads the
      // history it was handed instead, sees the call that already ran, and
      // carries on rather than asking for it again.
      await commit(arrivals.map((arrival): Entry => ({
        type: "run.started", runId, input: arrival.input,
        ...(arrival.from ? { from: arrival.from } : {}),
      })));

      // Every ceiling is checked where work is recorded, and a resumption
      // records nothing before its first turn — so a deadline that had already
      // passed was never seen. Checked once here too, before the harness is
      // handed anything.
      stopped ??= exceeded();

      function makeContext(): HarnessContext {
        const supplied = options.context;
        const current = supplied ? {
          ...(supplied.run ? { run: supplied.run } : {}),
          get turn() {
            const value = supplied.turn;
            return typeof value === "function" ? value() : value;
          },
        } : undefined;
        return {
          sessionId, runId,
          instructions: agent.instructions,
          history: () => toMessages({
            instructions: agent.instructions,
            entries: log.entries,
            ...(agent.attribution ? { attribution: true } : {}),
            ...(current ? { context: current } : {}),
          }),
          entries: () => log.entries,
          ...(current ? { context: current } : {}),
          ...(executor ? { tools: executor } : {}),
          commit,
          ...(store ? { drain, waitForInput } : {}),
          emit: (update) => updates.push(update),
          signal, hooks,
        };
      }

      async function stoppingHooks(outcome: HarnessResult) {
        const inputs: Entry[] = [];
        const outgoing: Delivery[] = [];
        for (const hook of hooks) {
          const response = await hook.beforeStop?.(hookContext!, outcome);
          if (response && "input" in response && outcome.status === "completed" && !signal.aborted && !stopped &&
              !log.entries.some(entry => entry.type === "hook.input" && entry.runId === runId && entry.hook === hook.name)) {
            inputs.push({ type: "hook.input", runId, hook: hook.name, input: response.input });
          }
          if (response && "deliveries" in response) outgoing.push(...response.deliveries);
        }
        return { inputs, deliveries: outgoing };
      }

      hookContext = makeContext();
      let outcome: HarnessResult;
      let outgoing: readonly Delivery[] = [];
      try {
        for (const hook of hooks) await hook.beforeRun?.(hookContext);
        for (;;) {
          outcome = stopped ? { status: "failed", error: stopped }
            : signal.aborted ? { status: "cancelled" }
            : await agent.harness.run(hookContext);
          if (stopped) outcome = { status: "failed", error: stopped };
          else if (signal.aborted) outcome = { status: "cancelled" };
          const ending = await stoppingHooks(outcome);
          if (!ending.inputs.length) { outgoing = ending.deliveries; break; }
          await commit(ending.inputs);
        }
      } catch (error) {
        if (error instanceof CommitFailed) throw error;
        outcome = { status: "failed", error: {
          code: "hook-or-harness", message: error instanceof Error ? error.message : String(error), retryable: false,
        } };
      }

      // A harness stopped by the ceiling reports a cancellation, because that is
      // all it saw. The run knows why it was cancelled and says so instead.
      const settled = stopped && outcome.status === "cancelled"
        ? { status: "failed" as const, error: stopped }
        : outcome;

      await commit(
        [{
          type: "run.finished", runId,
          outcome: settled.status === "completed" ? "completed" : settled.status === "cancelled" ? "cancelled" : "failed",
          ...(settled.status === "failed" ? { error: settled.error } : {}),
        }],
        outgoing,
      );

      if (settled.status === "completed") {
        return result = { status: "completed", output: settled.output, seq: log.seq, usage };
      }
      if (settled.status === "cancelled") return result = { status: "cancelled", seq: log.seq, usage };
      return stopping(settled.error);
    } catch (error) {
      if (error instanceof CommitFailed) {
        return result = { status: "failed", error: error.failure, seq: error.seq, usage };
      }
      throw error;
    } finally {
      if (hookContext) {
        const final = result ?? { status: "failed" as const, error: {
          code: "run-error", message: "The run could not finish.", retryable: false,
        }, seq: hookContext.entries().at(-1)?.seq ?? 0, usage };
        for (const hook of hooks) {
          try { await hook.afterRun?.(hookContext, final); }
          catch (error) {
            updates.push({ type: "hook.error", hook: hook.name, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      unwatch?.();
      clearInputWait?.();
      updates.close();
    }
  }
}

class CommitFailed extends Error {
  constructor(readonly failure: Failure, readonly seq: number) {
    super(failure.message);
  }
}

/**
 * Where the session actually is after a refused write. A conflict knows; every
 * other failure leaves the caller with the position it already had. Reporting
 * zero told a caller at forty that it was at the beginning.
 *
 * The `typeof` is not defensive noise: a store may report a conflict, and only
 * a `StoreConflict` carries the position. Casting on the code alone produced a
 * `RunResult.seq` of `undefined` under a type that says `number`.
 */
function positionOf(error: StoreError, fallback: number): number {
  const actual = (error as StoreConflict).actualSeq;
  return error.code === "conflict" && typeof actual === "number" ? actual : fallback;
}

const isArrival = (value: unknown): value is Arrival =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "input" in value;

/**
 * One arrival, or several.
 *
 * The elements decide it, because the outer shape cannot: an arrival names its
 * `input`, a content part names its `type`, and nothing is both. Reading every
 * array as a batch is what turned one image-and-text message into one entry per
 * part, each holding a part where whole content belongs.
 */
function arrivalsOf(input: RunAgentOptions["input"]): readonly Arrival[] {
  if (input === undefined) return [];
  // Nothing sent is nothing sent. Falling through committed a `run.started`
  // whose input was an empty array of content parts.
  if (Array.isArray(input) && input.length === 0) return [];
  if (Array.isArray(input) && input.length > 0 && input.every(isArrival)) return input;
  if (isArrival(input)) return [input];
  return [{ input: input as Content }];
}

/**
 * The activation still open on this log, if one is.
 *
 * `run.started` opens and `run.finished` closes, which is the same rule the
 * store maintains its claim from — read here from the entries rather than asked
 * of the store, because the log is the only thing that knows.
 */
function openRunId(entries: readonly Stored[]): string | undefined {
  let open: string | undefined;
  for (const entry of entries) {
    if (entry.type === "run.started") open = entry.runId;
    if (entry.type === "run.finished") open = undefined;
  }
  return open;
}

/** Token counts add; unknown stays unknown rather than becoming a zero. */
function accumulate(total: Usage, turn: Usage): void {
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (turn[key] !== undefined) total[key] = (total[key] ?? 0) + turn[key]!;
  }
}

async function open(store: Store, sessionId: string, agent: Agent, key?: string) {
  const existing = await store.read({ sessionId });
  if (existing.ok) {
    // `version` is documented as the boundary past which an agent is no longer
    // compatible with an existing session. Nothing was comparing it, so the
    // boundary held for exactly as long as nobody crossed it.
    const stored = existing.value.agent;
    if (stored.id !== agent.id || stored.version !== agent.version) {
      return err<StoreError>({
        code: "conflict",
        message: `Session ${sessionId} belongs to ${stored.id}@${stored.version}, not ${agent.id}@${agent.version}`,
        retryable: false,
      });
    }
    return existing;
  }
  if (existing.error.code !== "not-found") return existing;
  const created = await store.create({
    sessionId, agent: { id: agent.id, version: agent.version }, ...(key ? { key } : {}),
  });
  if (!created.ok) return created;
  return store.read({ sessionId });
}

/**
 * A bounded fan-out queue for ephemeral updates.
 *
 * One buffer of recent updates, which every listener starts from and which
 * never grows past its limit. That single rule gives three things:
 *
 * **A run nobody drains costs a fixed amount.** A headless worker used to
 * accumulate every delta of an entire activation, because the queue only ever
 * grew. Dropping the oldest is safe precisely because updates are not recovery
 * state and the committed log is.
 *
 * **Arriving late loses nothing that matters.** The first entry commits before
 * `runAgent` returns, so a caller that iterates immediately would otherwise
 * never see its own run start. A UI reconnecting mid-run gets recent history
 * for the same reason, without asking the store for it.
 *
 * **Everyone sees everything.** Each listener drains its own copy, so an
 * application can watch a run for telemetry and for a UI at once instead of the
 * two stealing events from each other.
 */
function createChannel<T>(limit = 1_024) {
  interface Listener { buffer: T[]; wake?: () => void }
  const listeners = new Set<Listener>();
  const replay: T[] = [];
  let closed = false;

  const bounded = (buffer: T[], value: T) => {
    if (buffer.length >= limit) buffer.shift();
    buffer.push(value);
  };

  return {
    push(value: T) {
      bounded(replay, value);
      for (const listener of listeners) {
        bounded(listener.buffer, value);
        listener.wake?.();
      }
    },
    close() {
      closed = true;
      for (const listener of listeners) listener.wake?.();
    },
    iterator(): AsyncIterator<T> {
      const listener: Listener = { buffer: [...replay] };
      listeners.add(listener);
      const done = (): IteratorResult<T> => {
        listeners.delete(listener);
        return { value: undefined, done: true };
      };
      return {
        async next(): Promise<IteratorResult<T>> {
          for (;;) {
            const value = listener.buffer.shift();
            if (value !== undefined) return { value, done: false };
            if (closed) return done();
            await new Promise<void>((resolve) => { listener.wake = resolve; });
          }
        },
        async return(): Promise<IteratorResult<T>> { return done(); },
      };
    },
  };
}
