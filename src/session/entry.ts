import type { Content } from "../content.js";
import type { Failure } from "../result.js";
import type { JsonValue } from "../json.js";

/** A model's request to invoke a tool. `arguments` is unparsed JSON as the provider sent it. */
export interface ToolCall {
  callId: string;
  name: string;
  arguments: string;
  /** The model may continue before this call reports its result. */
  async?: boolean;
}

/** Provider-owned continuation data, retained verbatim beside the output that produced it. */
export interface ProviderState {
  /** The provider wire allowed to replay these items. */
  provider: string;
  items: readonly JsonValue[];
}

export interface ToolResult {
  content: Content;
  /** Structured channel for the application and the UI. Never reaches the model. */
  details?: JsonValue;
  isError?: boolean;
}

/**
 * What a generation consumed.
 *
 * Absent stays absent — a count nobody reported is not a zero. This package
 * holds no rates and computes no money from tokens. Where an adapter does
 * arithmetic it is reconciling its wire's encoding to the meanings below:
 * normalization, which is an adapter's job, and never a new fact.
 *
 * That is why `costUsd` belongs here and a rate table does not. A cost the
 * provider *states* is an observation like the counts beside it, and dropping
 * it was the same mistake as dropping the model that served the request: an
 * application was left reconstructing, from a table it maintains by hand, a
 * number the wire had already given it. For a router that is not even possible
 * — it picks an upstream provider per request and adds its own margin, so no
 * static table can say what was charged.
 */
export interface Usage {
  /**
   * Input tokens that were neither read from nor written to a cache.
   *
   * **The three input counts are disjoint.** The prompt's total size is
   * `inputTokens + cacheReadTokens + cacheWriteTokens`; no field here is a
   * subset of another, so a caller sums and never subtracts.
   *
   * The wires disagree about this and one of them has to be converted. What
   * Anthropic calls `input_tokens` is already this — "tokens which were not
   * read from or used to create a cache". What OpenAI calls `prompt_tokens` is
   * the whole prompt, with `cached_tokens` counted inside it, so that adapter
   * subtracts once and callers stop having to know which wire answered.
   *
   * Disjoint is the choice that survives absence, which is the rule the rest of
   * this type runs on. Summing the fields you were given is right whichever
   * ones are missing; subtracting a field you were not given is not. Under the
   * other convention a heavily cached Anthropic turn priced its fresh tokens at
   * zero — quietly, because the subtraction was clamped at zero rather than
   * being allowed to go negative where somebody would have seen it.
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens served from a cache. Disjoint from `inputTokens`. */
  cacheReadTokens?: number;
  /** Input tokens written to a cache. Disjoint from `inputTokens`. */
  cacheWriteTokens?: number;
  /**
   * What the provider said this generation cost, in US dollars. Reported,
   * never derived: no adapter computes this from a rate, and one whose wire
   * does not carry a cost leaves it absent rather than estimating.
   */
  costUsd?: number;
}

/**
 * Who sent an arrival: what sort of sender, and which one.
 *
 * aglib mints exactly one kind — `"session"`, a delivery from another session —
 * and interprets no other. Every other kind is the application's word for one of
 * its own senders: a person, a channel, a schedule, a webhook. The vocabulary
 * belongs to whoever can close it, and that is never this package.
 *
 * Two fields because absence was carrying four facts. This used to be the
 * sending session's id alone, so an operator, a channel and a timer all said the
 * same thing by saying nothing, and a recipient could not tell a person typing
 * from a routine firing. Packing both into one string instead — `"routine:x"` —
 * would put the vocabulary in a convention nothing closes, which is how such a
 * field ends up with values that exist only by grep and a different reading on
 * every surface that renders it.
 */
export interface From {
  kind: string;
  id: string;
}

/**
 * The canonical vocabulary. This is the session's state, not a record of it:
 * the loop reads its context by projecting these and appends back to them, so
 * there is no second transcript that could disagree.
 *
 * `tool.started` carries only the call id — the assistant entry above it
 * already holds the call, and duplicating name and arguments would be a second
 * field for a value another field determines.
 */
export type Entry =
  | { type: "hook.input"; runId: string; hook: string; input: Content }
  | { type: "run.started"; runId: string; input: Content; from?: From }
  | {
      type: "assistant"; runId: string; content: Content;
      calls?: readonly ToolCall[]; usage?: Usage; providerState?: ProviderState;
      /**
       * What produced this turn, when a model did: which model answered and the
       * span it took. `Stored.at` is when the entry was committed, which is a
       * different fact and not a substitute — anything projecting a generation
       * needs both ends of the call, and the commit is neither of them.
       */
      generation?: { id: string; model?: string; startedAt: string; endedAt?: string };
    }
  | { type: "tool.started"; runId: string; callId: string }
  | { type: "tool.finished"; runId: string; callId: string; result: ToolResult }
  /** Compaction output. `replaces` is the seq up to which entries are folded; nothing is deleted. */
  | { type: "summary"; runId: string; content: string; replaces: number }
  | { type: "run.finished"; runId: string; outcome: "completed" | "failed" | "cancelled"; error?: Failure };

export type EntryType = Entry["type"];

/** An entry once the log has given it a position. */
export type Stored<T extends Entry = Entry> = T & { seq: number; at: string };

/**
 * Input delivered to a session, committed with the sender's own entries.
 * Spawning a child, replying to a parent and messaging a peer are all this.
 */
export interface Delivery {
  /** The session it is delivered to. */
  sessionId: string;
  input: Content;
  /**
   * Who sent it. Absent means the application did not say — not that nobody
   * did. Recorded on the receiving `run.started`, so an application can tell a
   * peer's message from its user's, and can see that it already answered one
   * that arrives twice. It becomes text the model reads only where the
   * recipient's agent asks, with `attribution`.
   */
  from?: From;
  /**
   * Where in the recipient's loop this lands. Defaults to "next".
   *
   * Three places, and each is an outcome a sender can reason about rather than
   * a level of urgency a harness interprets:
   *
   *   "interrupt" — the running activation ends, so the next one begins with
   *                 this. Its uncommitted work is lost; everything it had
   *                 already committed stays.
   *   "turn"      — folded into the activation already running, before its next
   *                 model call. Nothing in flight is lost. Immediately, if
   *                 nothing is running.
   *   "next"      — at the start of the recipient's next activation.
   *
   * This used to be `now | next | later`, and `now` meant either of the first
   * two depending on the harness — fold if it had a safe point, end the
   * activation if it did not. One word for "your message arrives and the work
   * continues" and "your message arrives and a turn's work is destroyed". The
   * doctrine was that a priority names the requirement and not the mechanism,
   * but those are not two mechanisms for one requirement: they are two
   * different things happening to somebody's work, and a runtime answer saying
   * which one you got was invented to paper over it. `later` named a fourth
   * thing that nothing implemented.
   *
   * **A harness that cannot honour one falls back to a later place, never an
   * earlier one.** A loop with no safe point cannot do "turn", so it does
   * "next" — the message waits. It does not end the activation instead, which
   * is what falling back through an ordered scale used to do: ask for the
   * gentlest useful thing and get the most destructive one.
   */
  priority?: "interrupt" | "turn" | "next";
  /**
   * The sender's key for this delivery. Two deliveries with the same id are the
   * same delivery, so a retried send does not arrive twice.
   */
  id?: string;
}
