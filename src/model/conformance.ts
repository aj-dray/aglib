/**
 * What any implementation of the model port must do.
 *
 * The port is one method, and almost everything it promises is about the shape
 * of an answer rather than its content: exactly one result and nothing after it,
 * a cancellation that arrives as a value, deltas that add up to the message,
 * tool arguments that parse, counts that stay absent when nobody reported them.
 * Those are the promises a run recovers on — and every one of them is invisible
 * to a test that only asks a model a question and reads the reply.
 *
 * So the suite cannot supply requests and expect responses: what a provider says
 * is the provider's, and two of the three implementations here reach one. What
 * a subject is asked for instead is a model **primed to say a scripted thing** —
 * the script in the port's own vocabulary, rendered by the subject onto whatever
 * it actually speaks, which for a wire is a stream of frames and for a fake is a
 * scripted response. A case then drives that model and holds the answer to the
 * port, without ever naming a provider's fields.
 *
 * The same trick runs the other way. An adapter that decodes a response
 * perfectly and never transmits the caller's tools is useless, and that half of
 * an adapter is pure encoding — which is why a wire also hands back a
 * `SentRequest`: its own translation of what went out, back into the port's
 * vocabulary. The alternative was to assert on the raw body, which would make
 * every case provider-specific and so not a shared contract at all.
 *
 * One request per model. Nothing in this port is a conversation — a `Model` is a
 * value you call — so a case wanting a second answer asks for a second model,
 * and no subject has to decide what a spent script means.
 *
 * Inert on purpose. Each case is a name and a function that throws, so the suite
 * drags no test framework into the package:
 *
 * ```ts
 * for (const item of defineModelConformance(subject)) test(item.name, item.run);
 * ```
 */
import type {
  Message, Model, ModelDelta, ModelError, ModelRequest, ModelResponse, ToolCall, ToolSpec, Usage,
} from "./model.js";
import type { Result } from "../result.js";
import type { JsonValue } from "../json.js";
import { textOf } from "../content.js";

/** One case: a name, and a function that throws when the contract is broken. */
export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

/**
 * What the provider should say, in the port's vocabulary.
 *
 * A subject renders each of these onto whatever it speaks. Two rendering rules
 * carry cases of their own, so they are stated here rather than assumed:
 *
 * - **Deltas arrive one at a time.** A subject that hands the whole body over at
 *   once cannot be cancelled part way through, and the case that pulls one delta
 *   and then gives up would prove nothing.
 * - **A wire behaves as `fetch` does about the signal.** An already-aborted
 *   request never reaches the provider, and a body dies when the caller gives
 *   up. A transport that ignores the signal lets an adapter that never forwarded
 *   it pass both cancellation cases.
 */
export type ModelScript =
  /** An answer that arrives in pieces. */
  | { kind: "text"; deltas: readonly string[] }
  /** An answer the model thought about first, aloud. */
  | { kind: "reasoning"; thoughts: readonly string[]; text: string }
  /** A turn that asks for tools, with each call's arguments fragmented on the way. */
  | { kind: "tool-calls"; calls: readonly ToolCall[] }
  /** An answer the provider cut off at the output ceiling, mid-sentence or mid-call. */
  | { kind: "truncated"; text: string; calls?: readonly ToolCall[] }
  /** An answer the provider declined to give. */
  | { kind: "refused" }
  /** An answer reporting exactly these counts, from exactly this model. */
  | { kind: "usage"; usage: Usage; model: string }
  /** An answer that says nothing about counts or about which model served it. */
  | { kind: "silent" }
  /** The provider refusing the request outright. Wires only. */
  | { kind: "status"; status: number; body: string }
  /** A body that delivers this much and then dies. Wires only. */
  | { kind: "cut"; text: string };

/**
 * What one outgoing request carried, translated back out of the wire's own
 * vocabulary by the subject. Absence is meaningful: an empty `toolNames`
 * asserts the request advertised no tools, and a missing `effort` asserts it
 * carried no reasoning control at all.
 */
export interface SentRequest {
  /**
   * Every text the request transmitted for the model to read, in order —
   * instructions first, then the conversation, wherever this wire puts them.
   * One list rather than a field per role, because the roles are exactly what
   * the wires disagree about: a tool result is a message on one and a block
   * inside the previous user turn on another, and what an adapter owes is that
   * the words arrive in the order they were said.
   */
  text: readonly string[];
  /** The names of the tools the request advertised. */
  toolNames: readonly string[];
  /** The JSON Schema the request advertised for each advertised tool. */
  toolSchemas: Readonly<Record<string, JsonValue>>;
  /** Each tool result the request carried, paired with the call it answers. */
  toolResults: readonly { callId: string; content: string }[];
  /** Each tool call the request carried back, so the provider can pair the result with it. */
  toolCalls: readonly ToolCall[];
  /** Media types of the image and file content the request transmitted, in order. */
  mediaTypes: readonly string[];
  /** The output ceiling the request carried, or absent where it carried none. */
  maxOutputTokens?: number;
  /** The provider-native reasoning control the request carried, verbatim, or absent. */
  effort?: JsonValue;
  /** The sampling control the request carried, or absent. */
  temperature?: number;
  /** How many cache breakpoints the request marked. */
  cacheMarks: number;
}

/** A model primed to answer one request, and — where there is a wire — that request. */
export interface Answering {
  model: Model;
  /** What the one request this model was given actually carried. Wires only. */
  sent?(): SentRequest;
}

/**
 * What this implementation does with the three request options a provider may
 * refuse, each of which the port says is honoured or honestly ignored.
 *
 * Declared rather than inferred from the request, because both answers look
 * identical from outside and only one of them is a defect: dropping `temperature`
 * is what the current Anthropic models require, and dropping it silently on a
 * wire that would have accepted it is a caller's control going nowhere.
 */
export interface Wire {
  /** Whether a level reaches the provider as its own depth control. */
  effort: "sent" | "ignored";
  /** Whether a sampling control reaches a provider that accepts one. */
  temperature: "sent" | "ignored";
  /** Whether `cacheAfter` reaches the provider as a breakpoint. */
  cache: "sent" | "ignored";
}

export interface ModelUnderTest {
  /**
   * A model primed to answer one request with `script`.
   *
   * Called once per request, so nothing leaks between cases, and never with a
   * script this subject's declarations say it cannot play.
   */
  answering(script: ModelScript): Answering | Promise<Answering>;
  /**
   * The transport under this implementation, where there is one the subject can
   * script and read back.
   *
   * `"none"` is a claim about the implementation, not a way out of the cases: a
   * model answering from something it already holds has no status to return, no
   * body to cut in half and no request to report — and those are the cases a
   * provider adapter most needs, so one that declares `"none"` is untested where
   * it matters.
   */
  wire: Wire | "none";
  /**
   * Whether a tool call's arguments reach the caller as they arrive.
   *
   * Declared rather than inferred from an empty stream, because "streamed
   * nothing" and "asked for no tools this turn" look the same from outside, and
   * an application rendering a call as it is typed would find out in production.
   */
  toolArguments: "streamed" | "whole";
  /** Whether this implementation can carry a model's reasoning back as deltas. */
  reasoning: "streamed" | "none";
  /**
   * Whether this wire states what a generation cost.
   *
   * A router does — it picks an upstream provider per request and adds its own
   * margin, so what it charged is a thing only it can say, and no rate table an
   * application keeps can reconstruct it. Most wires do not, and there the
   * field stays absent rather than being estimated from one.
   *
   * Declared both ways, because both are a promise: one that reports a cost has
   * to carry it, and one that does not has to leave it alone rather than
   * inventing a zero.
   */
  cost: "reported" | "none";
}

/** One generation, driven to its end. */
interface Streamed {
  deltas: readonly ModelDelta[];
  result: Result<ModelResponse, ModelError>;
}

function fail(what: string): never {
  throw new Error(`model conformance: ${what}`);
}

function holds(condition: boolean, what: string): asserts condition {
  if (!condition) fail(what);
}

function same(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, at) => same(item, expected[at]));
  }
  if (typeof actual !== "object" || typeof expected !== "object" || !actual || !expected) return false;
  const left = Object.keys(actual as object).sort();
  const right = Object.keys(expected as object).sort();
  return same(left, right)
    && left.every((key) => same((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
}

function equals(actual: unknown, expected: unknown, what: string): void {
  if (!same(actual, expected)) {
    fail(`${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function absent(actual: unknown, what: string): void {
  if (actual !== undefined) fail(`${what} — expected nothing, got ${JSON.stringify(actual)}`);
}

/** Unwraps a result the case expects to have succeeded. */
function got(result: Result<ModelResponse, ModelError>, what: string): ModelResponse {
  if (!result.ok) fail(`${what} — ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Unwraps a result the case expects to have failed, with this code. */
function failed(result: Result<ModelResponse, ModelError>, code: ModelError["code"], what: string): ModelError {
  holds(!result.ok, `${what} — it succeeded instead`);
  equals(result.error.code, code, `${what} — the code says ${code}`);
  return result.error;
}

const joined = (deltas: readonly ModelDelta[], type: ModelDelta["type"]): string =>
  deltas.filter((delta) => delta.type === type).map((delta) => "text" in delta ? delta.text : delta.arguments).join("");

/** Drains a generation, keeping what it streamed on the way to its result. */
async function drive(
  generation: AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>>,
): Promise<Streamed> {
  const deltas: ModelDelta[] = [];
  let step = await generation.next();
  while (!step.done) {
    deltas.push(step.value);
    step = await generation.next();
  }
  return { deltas, result: step.value };
}

/** One opaque pixel: enough for an adapter to carry, too small to matter. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const user = (text: string): Message => ({ role: "user", content: text });

/** The arguments a call carries, compared as JSON rather than as a string a wire may re-spell. */
const parsed = (raw: string, what: string): unknown => {
  try { return JSON.parse(raw) as unknown; } catch { return fail(`${what} — ${JSON.stringify(raw)} is not JSON`); }
};

const asked: readonly ToolCall[] = [
  { callId: "call-1", name: "balance", arguments: "{\"account\":\"main\",\"limit\":3}" },
  // A call with nothing to pass. Both wires stream no fragments for it, and a
  // caller still has to be handed arguments it can parse.
  { callId: "call-2", name: "clock", arguments: "{}" },
];

const tools: readonly ToolSpec[] = [
  {
    name: "balance", description: "Read an account balance",
    parameters: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
  },
  { name: "clock", description: "The time now", parameters: { type: "object", properties: {} } },
];

/** A turn of every shape the port carries: instruction, question, call, result, reply. */
const conversation: readonly Message[] = [
  { role: "system", content: "You are a bookkeeper." },
  { role: "user", content: "What is the balance?" },
  { role: "assistant", content: "Looking that up.", calls: [{ callId: "call-1", name: "balance", arguments: "{\"account\":\"main\"}" }] },
  { role: "tool", callId: "call-1", content: "1250" },
  { role: "user", content: "Thanks." },
];

export function defineModelConformance(subject: ModelUnderTest): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const define = (name: string, run: () => Promise<void>): void => { cases.push({ name, run }); };

  /** One scripted generation, driven to its end. */
  const answering = async (script: ModelScript, request: ModelRequest): Promise<Streamed> => {
    const primed = await subject.answering(script);
    return await drive(primed.model.generate(request));
  };

  // ---- The shape of an answer ---------------------------------------------

  define("a generation ends in one result, and yields nothing after it", async () => {
    // A generator that falls off its end returns `undefined`, which typechecks
    // as nothing and tells a caller nothing: the loop reads `step.value.ok` to
    // decide whether the run failed, and would throw on the way to deciding.
    const primed = await subject.answering({ kind: "text", deltas: ["one ", "two"] });
    const generation = primed.model.generate({ messages: [user("say something")] });

    let step = await generation.next();
    while (!step.done) {
      holds(["text.delta", "reasoning.delta", "tool-call.delta"].includes(step.value.type),
        `every delta is one of the port's three kinds — got ${JSON.stringify(step.value)}`);
      step = await generation.next();
    }
    holds(typeof (step.value as { ok?: unknown } | undefined)?.ok === "boolean",
      "a generation returns a Result, never nothing");

    const after = await generation.next();
    holds(after.done === true && after.value === undefined, "and nothing follows the result");
  });

  define("the text a caller streamed is the text the message ends up holding", async () => {
    const deltas = ["The ", "balance ", "is 1250."];
    const streamed = await answering({ kind: "text", deltas }, { messages: [user("what is the balance?")] });
    const response = got(streamed.result, "generate");

    equals(joined(streamed.deltas, "text.delta"), deltas.join(""), "the caller saw the answer arrive");
    equals(textOf(response.message.content), deltas.join(""), "and the message holds the same words");
    equals(response.finishReason, "stop", "a turn that simply answered stopped");
    equals(response.message.calls ?? [], [], "and asked for nothing");
  });

  define("a turn that asks for tools carries every call, with its id and arguments that parse", async () => {
    const streamed = await answering({ kind: "tool-calls", calls: asked }, {
      messages: [user("look it up")], tools,
    });
    const response = got(streamed.result, "generate");
    const reported = response.message.calls ?? [];

    equals(reported.map((call) => call.callId), asked.map((call) => call.callId),
      "every call comes back, under the id the provider gave it — the id is what a result is paired with");
    equals(reported.map((call) => call.name), asked.map((call) => call.name), "and the tool it asked for");
    for (const [at, call] of reported.entries()) {
      // Complete JSON, not the fragments it arrived as. A caller parses this to
      // decide whether a tool may run at all, so half of an object is worse than
      // none — it parses on a good day.
      equals(parsed(call.arguments, `call ${call.callId}`), parsed(asked[at]!.arguments, "the script"),
        "the arguments parse, whole");
    }
    equals(response.finishReason, "tool-calls", "a turn holding calls says that is why it stopped");
  });

  define("a turn cut off at the output ceiling says so", async () => {
    // The reason the loop cannot read this from the absence of tool calls: a
    // truncated turn looks exactly like a finished one, and reporting it as an
    // answer hands the caller half a sentence dressed as a whole one.
    const streamed = await answering({ kind: "truncated", text: "The balance is 12" }, { messages: [user("go")] });
    const response = got(streamed.result, "generate");
    equals(response.finishReason, "length", "the ceiling, not a full stop");
    equals(textOf(response.message.content), "The balance is 12", "and what did arrive is kept");
  });

  define("a turn cut off while it was asking for tools still says it was cut off", async () => {
    // The precedence the loop's truncation guard rests on. A response holding
    // calls looks like a turn that asked for them, and half a request can parse
    // as whole JSON — so an adapter that lets the calls decide the reason hands
    // a batch built from a severed argument list to a tool that will run it.
    const streamed = await answering({ kind: "truncated", text: "Looking", calls: [asked[0]!] }, {
      messages: [user("go")], tools,
    });
    const response = got(streamed.result, "generate");
    equals(response.finishReason, "length", "the ceiling outranks the calls");
    equals((response.message.calls ?? []).length, 1,
      "and the calls that did arrive are still reported, so the model can be told why they did not run");
  });

  define("a turn the provider declined says so", async () => {
    const streamed = await answering({ kind: "refused" }, { messages: [user("go")] });
    equals(got(streamed.result, "generate").finishReason, "refusal", "a refusal is not a completed answer");
  });

  define("the counts the provider reported reach the caller, and so does which model answered", async () => {
    const counted: Usage = { inputTokens: 120, outputTokens: 6, cacheReadTokens: 80 };
    const streamed = await answering({ kind: "usage", usage: counted, model: "acme/small" }, {
      messages: [user("say ok")],
    });
    const response = got(streamed.result, "generate");
    equals(response.usage, counted, "the counts come back as they were reported");
    // Not the id the model was built with: a provider may answer with a dated
    // variant, and an application pricing a run has to price what served it.
    equals(response.model, "acme/small", "and the model that actually served the request");
  });

  define("the input counts do not overlap, whichever wire answered", async () => {
    // The wires disagree: Anthropic's `input_tokens` already excludes what was
    // cached, OpenAI's `prompt_tokens` includes it. `Usage` picks one meaning —
    // disjoint — so an application never has to ask which one it is holding.
    //
    // A caller sums. This is the case that lets it: the total below is only
    // right if no field is counted twice, and the one that used to subtract
    // instead priced a cached Anthropic turn's fresh tokens at zero.
    const split: Usage = { inputTokens: 40, outputTokens: 6, cacheReadTokens: 80 };
    const streamed = await answering({ kind: "usage", usage: split, model: "acme/small" }, {
      messages: [user("say ok")],
    });
    const { usage } = got(streamed.result, "generate");
    equals(usage.inputTokens, 40, "input excludes what was served from cache");
    equals(usage.cacheReadTokens, 80, "and the cached tokens are reported beside it, not inside it");
    equals((usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0), 120, "so the prompt's size is the sum");
  });

  if (subject.cost === "reported") {
    define("a cost the provider states reaches the caller", async () => {
      // Carried, never computed. An application that had to price this itself
      // was reconstructing, from a table it maintains by hand, a number the
      // wire had already given it — and for a router it could not: the upstream
      // provider is chosen per request.
      const charged: Usage = { inputTokens: 120, outputTokens: 6, costUsd: 0.0042 };
      const streamed = await answering({ kind: "usage", usage: charged, model: "acme/small" }, {
        messages: [user("say ok")],
      });
      equals(got(streamed.result, "generate").usage.costUsd, 0.0042, "the charge comes back as it was reported");
    });
  } else {
    define("a wire that states no cost does not invent one", async () => {
      const streamed = await answering(
        { kind: "usage", usage: { inputTokens: 120, outputTokens: 6 }, model: "acme/small" },
        { messages: [user("say ok")] },
      );
      absent(got(streamed.result, "generate").usage.costUsd,
        "usage.costUsd is absent on a wire that does not carry one");
    });
  }

  define("what the provider did not report is absent, not zero", async () => {
    const streamed = await answering({ kind: "silent" }, { messages: [user("say ok")] });
    const response = got(streamed.result, "generate");
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
      // A zero is a count. An application summing them for a ceiling would be
      // told this generation was free, which is a different claim from silence.
      absent(response.usage[field], `usage.${field} is absent when the provider reported none`);
    }
    absent(response.model, "and the model that answered is not invented");
  });

  define("a model names itself", async () => {
    const { model } = await subject.answering({ kind: "text", deltas: ["hello"] });
    holds(typeof model.id === "string" && model.id.length > 0, "a model has an id, so a log can say which one ran");
  });

  // ---- Giving up ----------------------------------------------------------

  define("a generation cancelled before it starts fails cancelled, and does not throw", async () => {
    const streamed = await answering({ kind: "text", deltas: ["never ", "delivered"] }, {
      messages: [user("go")], signal: AbortSignal.abort(),
    });
    const error = failed(streamed.result, "cancelled", "an already-cancelled generation reports cancelled");
    equals(error.retryable, false, "a caller that gave up is not told to try again");
    equals(streamed.deltas, [], "and nothing was streamed to it");
  });

  // ---- What differs, as the subject declares it ---------------------------

  if (subject.reasoning === "streamed") {
    define("reasoning reaches the caller as deltas, and never as something the model said", async () => {
      const streamed = await answering({ kind: "reasoning", thoughts: ["Check ", "the ledger."], text: "1250" }, {
        messages: [user("what is the balance?")], effort: "high",
      });
      const response = got(streamed.result, "generate");
      equals(joined(streamed.deltas, "reasoning.delta"), "Check the ledger.", "the caller saw it being thought");
      // Reasoning is not speech. Folded into the message it would be committed
      // as the assistant's words and replayed to the provider next turn, as if
      // the model had said aloud what it only thought.
      equals(textOf(response.message.content), "1250", "and the message holds only what was said");
    });
  } else {
    define("an implementation that carries no reasoning emits none", async () => {
      const streamed = await answering({ kind: "text", deltas: ["hello"] }, { messages: [user("go")] });
      holds(!streamed.deltas.some((delta) => delta.type === "reasoning.delta"),
        "a subject declaring no reasoning must not emit a delta the suite would then not check");
    });
  }

  if (subject.toolArguments === "streamed") {
    define("a tool call's arguments reach the caller as they are produced", async () => {
      const call = asked[0]!;
      const streamed = await answering({ kind: "tool-calls", calls: [call] }, {
        messages: [user("look it up")], tools,
      });
      const [reported] = got(streamed.result, "generate").message.calls ?? [];
      holds(reported !== undefined, "the call came back");

      const fragments = streamed.deltas
        .filter((delta): delta is Extract<ModelDelta, { type: "tool-call.delta" }> => delta.type === "tool-call.delta");
      holds(fragments.length > 0, "the arguments were streamed at all");
      equals([...new Set(fragments.map((delta) => delta.callId))], [reported.callId],
        "every fragment names the call it belongs to — an application renders them per call");
      equals(fragments.map((delta) => delta.arguments).join(""), reported.arguments,
        "and they reassemble into exactly what the call ended up holding");
    });
  } else {
    define("an implementation that does not stream arguments emits no tool-call deltas", async () => {
      const streamed = await answering({ kind: "tool-calls", calls: asked }, {
        messages: [user("look it up")], tools,
      });
      holds(!streamed.deltas.some((delta) => delta.type === "tool-call.delta"),
        "a subject declaring `whole` must not emit a delta the suite would then not check");
    });
  }

  if (subject.wire === "none") {
    define("an implementation with no wire under it says so by not offering one", async () => {
      const primed = await subject.answering({ kind: "text", deltas: ["hello"] });
      holds(primed.sent === undefined,
        "a subject that can report what it sent declares a wire, rather than offering a report nothing reads");
    });
    return cases;
  }

  const wire = subject.wire;

  // ---- What the provider refused ------------------------------------------

  const refusals = [
    { status: 401, body: "{\"error\":{\"message\":\"invalid api key\"}}", code: "auth", retryable: false },
    { status: 429, body: "{\"error\":{\"message\":\"rate limit exceeded\"}}", code: "rate-limit", retryable: true },
    {
      status: 400,
      body: "{\"error\":{\"message\":\"prompt is too long: 300000 tokens > 200000 maximum context length\"}}",
      code: "context-length", retryable: false,
    },
    { status: 500, body: "upstream is unwell", code: "provider", retryable: true },
    { status: 404, body: "{\"error\":{\"message\":\"no such model\"}}", code: "failed", retryable: false },
  ] as const;

  for (const refusal of refusals) {
    define(`a ${refusal.status} from the provider is a ${refusal.code} failure a caller can act on`, async () => {
      const streamed = await answering({ kind: "status", status: refusal.status, body: refusal.body }, {
        messages: [user("go")],
      });
      const error = failed(streamed.result, refusal.code, `${refusal.status} is ${refusal.code}`);
      // The whole of what a backoff loop reads. Getting it wrong costs either a
      // run that gives up on a rate limit or one that hammers a bad credential.
      equals(error.retryable, refusal.retryable, `a ${refusal.code} failure says whether trying again is worth it`);
      holds(error.message.length > 0, "and carries something a human can read");
      equals(streamed.deltas, [], "a refused request streamed nothing");
    });
  }

  define("a body that dies part way through is a failure, not a thrown generator", async () => {
    // Without this the generator throws, `run.result` rejects instead of
    // resolving, no `run.finished` is ever committed, and the activation stays
    // open until its claim expires.
    const streamed = await answering({ kind: "cut", text: "The bal" }, { messages: [user("go")] });
    const error = failed(streamed.result, "provider", "a dropped body is a provider failure");
    equals(error.retryable, true, "a connection that dropped is worth trying again");
    holds(streamed.deltas.length > 0, "and what did arrive had already reached the caller");
  });

  define("a generation cancelled while it streams ends cancelled, not as a provider fault", async () => {
    const primed = await subject.answering({ kind: "text", deltas: ["one ", "two ", "three"] });
    const controller = new AbortController();
    const generation = primed.model.generate({ messages: [user("count")], signal: controller.signal });

    const first = await generation.next();
    holds(first.done === false, "the first delta arrived");
    // The moment that matters: a caller that has read something and then gives
    // up. A stream torn down under an adapter looks exactly like one the network
    // dropped, and only the signal tells them apart.
    controller.abort();

    let step = await generation.next();
    while (!step.done) step = await generation.next();
    equals(failed(step.value, "cancelled", "a cancelled stream reports cancelled").retryable, false,
      "a caller that gave up is not told to try again");
  });

  // ---- What went out ------------------------------------------------------

  /** One scripted generation, reported back as the request it put on the wire. */
  const sending = async (request: ModelRequest): Promise<SentRequest> => {
    const primed = await subject.answering({ kind: "text", deltas: ["ok"] });
    holds(primed.sent !== undefined, "a subject declaring a wire owes a report of what it sent");
    got((await drive(primed.model.generate(request))).result, "generate");
    return primed.sent();
  };

  define("everything the caller said reaches the provider, in the order it was said", async () => {
    // Every role the port carries, in one turn. The wires disagree about where
    // each one goes — an instruction is hoisted out of the list on one and left
    // in it on the other, a tool result is a message here and a block inside the
    // previous user turn there — and none of that may lose a word or reorder one.
    const sent = await sending({ messages: conversation });
    equals(sent.text, ["You are a bookkeeper.", "What is the balance?", "Looking that up.", "1250", "Thanks."],
      "the instruction, the question, the reply, the result and the follow-up all arrive, in that order");
  });

  define("a tool result reaches the provider paired with the call it answers", async () => {
    // Unpaired, a provider rejects the turn outright: it has an answer and no
    // question. This is the one encoding mistake that makes a session unusable
    // rather than merely worse.
    const sent = await sending({ messages: conversation, tools });
    equals(sent.toolResults, [{ callId: "call-1", content: "1250" }], "the result carries the id it answers");
    equals(sent.toolCalls.map((call) => call.callId), ["call-1"], "and the call it answers went back with it");
    equals(parsed(sent.toolCalls[0]!.arguments, "the call sent back"), { account: "main" },
      "still holding the arguments the model asked with");
  });

  define("the tools the caller advertised reach the provider with their schemas", async () => {
    const sent = await sending({ messages: [user("look it up")], tools });
    equals([...sent.toolNames].sort(), tools.map((tool) => tool.name).sort(), "every tool is advertised");
    for (const tool of tools) {
      equals(sent.toolSchemas[tool.name], tool.parameters,
        `${tool.name} is advertised with the schema it declared — the model calls what it was shown`);
    }
    equals((await sending({ messages: [user("look it up")] })).toolNames, [],
      "and a request with no tools advertises none");
  });

  define("an image reaches the provider as an image", async () => {
    const sent = await sending({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mediaType: "image/png", source: { kind: "inline", data: PIXEL } },
        ],
      }],
    });
    equals(sent.mediaTypes, ["image/png"], "the picture is transmitted as a picture, not as prose about one");
    holds(sent.text.includes("what is this?"), "and the text beside it is not lost carrying it");
  });

  define("a block this wire cannot carry is dropped, not stringified into something the model reads", async () => {
    // An opaque block belongs to the provider that made it and is valid on no
    // other wire. The tempting fix is to serialize what cannot be sent, which
    // puts another provider's internals — signatures and all — in front of the
    // model as if a person had typed them.
    const sent = await sending({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "opaque", provider: "another-provider", data: { signature: "sig-9" } },
        ],
      }],
    });
    equals(sent.text, ["what is this?"], "the words go, the block this wire has no place for does not");
  });

  define("the output ceiling the caller set reaches the provider", async () => {
    equals((await sending({ messages: [user("go")], maxOutputTokens: 64 })).maxOutputTokens, 64,
      "a ceiling nothing transmits is a ceiling nothing enforces");
  });

  define(`effort is ${wire.effort === "sent" ? "sent as this provider's own depth control" : "dropped rather than sent"}`,
    async () => {
      const withEffort = await sending({ messages: [user("think first")], effort: "high" });
      absent((await sending({ messages: [user("think first")] })).effort,
        "a request that asked for no effort carries no depth control");
      if (wire.effort === "ignored") {
        absent(withEffort.effort, "a provider with no such control is given none, rather than a budget invented for it");
        return;
      }
      holds(withEffort.effort !== undefined, "the level the caller asked for reaches the provider");
    });

  define(`temperature is ${wire.temperature === "sent" ? "sent" : "dropped rather than sent to a provider that rejects it"}`,
    async () => {
      const withTemperature = await sending({ messages: [user("go")], temperature: 0.2 });
      absent((await sending({ messages: [user("go")] })).temperature, "a request that set none carries none");
      if (wire.temperature === "ignored") {
        // Not an oversight: the current Anthropic models reject sampling
        // controls, so forwarding one turns every request into a 400.
        absent(withTemperature.temperature, "a provider that rejects sampling controls is sent none");
        return;
      }
      equals(withTemperature.temperature, 0.2, "the value the caller set reaches the provider");
    });

  define(`cacheAfter is ${wire.cache === "sent" ? "marked on the wire" : "dropped on a wire with no breakpoint"}`,
    async () => {
      const marked = await sending({ messages: conversation, cacheAfter: 1 });
      equals((await sending({ messages: conversation })).cacheMarks, 0, "a request that asked for no breakpoint marks none");
      if (wire.cache === "ignored") {
        equals(marked.cacheMarks, 0, "a wire that caches by itself is not sent a mark it has no field for");
        return;
      }
      holds(marked.cacheMarks > 0, "the prefix the caller ended is marked, or nothing is cached and every turn pays");
    });

  return cases;
}
