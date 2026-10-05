# Proposal: an answer of a given shape, from any model — Jev included

> **Status: proposal, for decision.** This file lives on a branch for review only. `AGENTS.md`
> says plans live outside the repository, so it should not merge as-is: if it is accepted, its
> content lands as edits to `INTERFACE.md` and `ARCHITECTURE.md` in the implementing PR, and this
> file is deleted. Written 2026-10-05 against `main` at `b25efbe` (v0.6.5).

## The recommendation in one paragraph

Add **one optional field to `ModelRequest`, `output`: the JSON Schema the answer must satisfy.**
Leave it out and you get free text, as today. Each adapter sends the schema the way its provider
expects it. An LLM wire uses that provider's structured-output parameter. A new Typesafe adapter
turns a schema made of described choices into Jev `questions`. Any schema it cannot express, and
any request for free text or tools, **fails typed as `unsupported`**. The answer is always a JSON
document in `message.content`. `ModelResponse` gains one observation, `probabilities`, which is
present only when the provider reported it (Jev does). The typed result comes from
`defineOutput({ schema })`, a zod declaration built the same way `defineTool` is: it gives you the
JSON Schema to send and a `parse` that returns `Result<T, …>`. Usage and cost reach the caller on
`ModelResponse.usage`, as they already do, so nothing changes for accounting. The result is one call
shape, `model.generate(request)`. Jev is a provider behind it with no special case, and the same
decision request can run on Jev or on DeepSeek. That is the comparison the detector eval made by hand.

## Corrections to the brief

Each of these changes what the proposal says, so they come first.

- **`docs/SPEC.md` no longer exists.** Commit `40b1466` split it into the four documents that
  `AGENTS.md` lists. The rejected alternatives the brief pointed to now sit in `PRODUCT.md`
  (inclusion test, money) and `ARCHITECTURE.md` (accounting, ports). This proposal edits those.
- **There is no `aglib/inference` module, and aglib has no telemetry.** The provider seam is the
  `model` port (`src/model/`). Telemetry is something the host projects from log entries:
  recruitment-os's `telemetry/spans.ts` reads `assistant` and `model.finished` entries. Usage
  reaches the host as data and is never emitted by aglib.
- **OpenAI's Luna-based product does not take a bare prompt and infer a schema.** It is the
  **Decisions API**, announced at DevDay on 2026-09-29: "a specific set of user-defined questions
  with finite pre-defined answers". That is the same shape as Jev. It is in limited preview, and no
  endpoint, field names or price have been published. So mode (d), as briefed, is not something any
  provider sells. What is real is JSON mode (`json_object`), where the model picks the structure.
  Below, that is a permissive schema rather than a mode of its own.
- **Jev has no span type.** Typesafe's own docs say to enumerate candidate spans and ask a choice
  over them, which is what `jev.ts` already does. Spans stay an application encoding.

## 1. Audit: what aglib does today

### How a provider is modelled

A `Model` is a value: provider, credential and model together, behind one method,
`generate(request): ModelGeneration` (`src/model/model.ts`). The generation is an async generator.
It yields `ModelDelta`s (text, reasoning, tool-call fragments) and returns
`Result<ModelResponse, ModelError>`. There are four adapters:

| Adapter | Wire | Notes |
| --- | --- | --- |
| `anthropic` | Messages API over SSE | already sends `output_config.effort` |
| `openai-compatible` (+ `createOpenRouterModel`) | Chat Completions over SSE | OpenRouter's `usage.cost` → `costUsd` |
| `openai-responses` | Responses API over the SDK's WebSocket | lanes per `stream_id` |
| `fake` | none | answers the same conformance cases |

The HTTP wires share one retrying `fetch` (`src/model/retry.ts`). It retries a wait (408/409/425/429/5xx, transport errors,
OpenRouter's in-flight 402) before the first delta, honouring `Retry-After`, up to four retries and
180 s in total. An aborted `signal` ends a wait at once. `aglib/model/conformance` is the executable
contract. Every adapter, and the fake, answers the same named cases through a scripted wire.

### How a request and a response are typed

`ModelRequest` = `messages`, `tools?`, `maxOutputTokens?`, `temperature?`, `effort?`,
`cacheAfter?`, `signal?`. It has no model name, by design. `ModelResponse` =
`message { content, calls? }`, `finishReason` (`stop | tool-calls | length | refusal`), `usage`,
`model?` (what actually served), `providerState?`. `ModelError.code` is one of `auth`, `rate-limit`,
`context-length`, `cancelled`, `provider` or `failed`, plus the provider's own `status`, `errorType`
and `errorCode`.

### Structured output today: none

Nothing on any wire sends `response_format`, `text.format`, `output_format`/`output_config.format`,
`tool_choice` or `strict`. `encodeTool` on the chat wire even sends `strict: false`. The only
schema-bearing thing in the port is `ToolSpec.parameters`, which is JSON Schema built from zod by
`defineTool`. A caller who wants JSON today prompts for it and parses text, with nothing
constraining the output. recruitment-os does not do this anywhere: its summariser reads a `Title:`
line with a regex.

### How usage and cost reach the caller

- `Usage` = `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` (the three input
  counts are disjoint), and `costUsd`. `costUsd` appears only where the wire states a cost, which
  today is OpenRouter. Nothing is derived. A count a provider did not report is absent, not zero.
- In a run, every `assistant` and `model.finished` entry carries its generation's `Usage`, and
  `runAgent` sums them on every outcome.
- Outside a run, the caller holds `ModelResponse.usage` and `.model` and records them however it
  likes. `INTERFACE.md` already says an application may commit its own auxiliary call as a
  `model.finished` entry with a `purpose`.

**What the host does with it (recruitment-os, read 2026-10-05):**

- **The ledger.** It is the view `query_v1.spend`. It unions `runtime.paid` (filled by a trigger from
  `assistant`/`model.finished` entries), `account:*` effects (the summariser) and voice sessions.
- **Where no cost was stated.** `estimatedUsd` is stamped from the host's own price table
  (`savedEstimate`).
- **What has no way into the ledger:**
  - one-off calls outside a session, apart from the `account:` effect;
  - the image describer;
  - embeddings;
  - dictation.

  None of them is recorded. That gap is the host's to close, not aglib's, but a search-bar Jev call
  lands right in it (see §5).

## 2. What the providers offer (primary sources, read 2026-10-05)

### Typesafe Jev

- **Request.** `POST https://api.typesafe.ai/v1/systemone`, with `Authorization: Bearer`. The body
  is `{ model, state, questions }`.
  - `state` may be a string, an object or an array. It is text only: no images.
  - `questions` maps a name to one of three question types:
    - `choice`: `criteria` maps each option to a description, or to null, up to 255 options;
    - `score`: an ordered array of 2 to 10 levels;
    - `noul`: a yes/no question.

    Each question also takes `instructions`.
  - There is no temperature, no system field, no streaming, and one state per request.
- **Response.** `{ model, answers, usage: { input_tokens, output_tokens } }`, where `model` is the
  versioned id, currently `jev-1.13.0`. A choice answer is
  `{ type: "choice", choice, probabilities, confidence }`, and `confidence` is a documented function
  of `probabilities`. A noul answer is `{ type: "noul", noul }`. **The response has no cost field.**
  The request id comes back in the `x-typesafe-request-id` header.
- **Errors and limits.**
  - Status codes: 401, 422 (FastAPI `detail[]`), 429, and 529 for "Overloaded".
  - Rate-limit headers: `Retry-After` and `retry-after-ms`.
  - Limits: 64k tokens of context, 80 req/s.
- **Price.** $42 per billion input tokens ($0.042/M), and output is free. At about 1,360 input tokens
  per detector call that is about $0.00006 a call, which matches the eval.
- **Other ways to reach it.** OpenRouter (`~typesafe/jev-latest` at `https://openrouter.ai/api`),
  Vercel and Pydantic gateways all speak *Typesafe's* wire, not chat completions.
- **Spans and weaknesses.** There is no span type. The docs list counting, dates, indirection,
  prompt injection and a bias toward the first option as known weaknesses.
- **Sources.** docs.typesafe.ai `/api`, `/models`, `/primitives/choice`, `/confidence`,
  `/concepts/state`, `/model-jaggedness/jev-1.13`; and `https://api.typesafe.ai/openapi.json`.
- **Not verified live.** No live call was made for this proposal. The shapes above come from the
  published OpenAPI spec and docs, and match what `jev.ts` reads (`answers.<q>.choice`, `usage`).

### OpenAI Decisions API (the "Luna wrapper")

- **What was announced.** It appeared in the DevDay 2026 recap (2026-09-29): "focusing Luna's
  intelligence on a specific set of user-defined questions with finite pre-defined answers.
  Developers supply context using text or images, and get back answers…". It is in limited preview,
  with "broad release planned in the coming days".
- **What has not been published.** There is no endpoint, field names, model id or price;
  `developers.openai.com/api/reference/resources/decisions` returns 404. No SDK has a resource for
  it as of openai-python 3.24.0 and openai-node 7.28.0.
- **Speed.** Staff describe "decisions in less than a few hundreds of milliseconds".
- **What it means for this proposal.** It is a second Jev-shaped provider, and when its contract is
  published it should be a second adapter for the same described-choice schema. Base `gpt-6-luna`
  costs $0.10/M input and $0.50/M output.
- **Sources.** openai.com/index/devday-2026-recap; developers.openai.com/api/docs/models/gpt-6-luna;
  the changelog; the SDK release notes.

### Schema-constrained JSON from general LLMs

| Provider | Request field | "Choose one" primitive | Per-option probabilities | Notes that shape the design |
| --- | --- | --- | --- | --- |
| OpenAI Responses | `text.format: { type: "json_schema", name, schema, strict }`; `{ type: "json_object" }` | no; `enum` / `anyOf` | no; token logprobs only, and not on GPT-6 with reasoning effort above `none` | root must be an object, every field `required`, `additionalProperties: false`; `const` is not in the listed keywords (the size limit counts "const values", so probably accepted, **to verify live**); refusal is a `refusal` content part |
| OpenAI Chat Completions | `response_format: { type: "json_schema", json_schema: { name, schema, strict } }` | no | no | same subset; `json_object` is "not recommended" for new models and the prompt must mention JSON |
| Anthropic Messages | **GA** `output_config: { format: { type: "json_schema", schema } }`; the beta `output_format` is deprecated | no; `enum`, `const`, `anyOf` | no logprobs at all | no `json_object` equivalent; no `minimum`/`maximum`/`minLength`, `minItems` only 0 or 1; `refusal` stop is billed and may not conform; enum casing "not guaranteed"; incompatible with citations and prefill |
| OpenRouter | `response_format` as Chat; `provider: { require_parameters: true }` | no | where the endpoint supports `logprobs` | **without `require_parameters`, an unsupported `response_format` is silently ignored**; `strict` is "sometimes only a strong hint"; `usage.cost` on every response |
| Gemini | `generationConfig.responseFormat` (successor to `responseJsonSchema`); `text/x.enum` | **yes**, `text/x.enum` (may be on a deprecation path) | logprobs only | aglib reaches it through OpenRouter, so its own field is not used here |
| vLLM ≥ 0.12 | `structured_outputs: { choice \| regex \| json \| grammar }`; `response_format` json_schema | **yes**, `choice` (one per request) | token logprobs only | `guided_*` fields were removed in v0.12.0 |

None of the general LLM APIs returns a probability per option, so only Jev does. Jev and the
Decisions API ask *several* independent choice questions over one context in a single call. The
nearest LLM equivalent is an object schema with one enum field per question.

**Sources:**

- developers.openai.com/api/docs/guides/structured-outputs.md, and the Responses and Chat create
  references;
- platform.claude.com/docs/en/build-with-claude/structured-outputs.md;
- openrouter.ai/docs/guides/features/structured-outputs.md, provider-selection.md and
  usage-accounting.md;
- ai.google.dev/api/generate-content;
- docs.vllm.ai/en/latest/features/structured_outputs.html.

## 3. The design

### The one field

```ts
// src/model/model.ts
export interface ModelRequest {
  messages: readonly Message[];
  tools?: readonly ToolSpec[];
  /**
   * The shape the answer must take, as JSON Schema. Absent: the answer is free text.
   *
   * Every adapter either sends it as its provider's own constraint or fails the
   * request `unsupported` before anything is sent. It is never dropped: a caller
   * that asked for JSON and was handed prose would parse a sentence.
   */
  output?: JsonValue;
  // maxOutputTokens, temperature, effort, cacheAfter, signal: unchanged
}

export interface ModelResponse {
  /** With `output`, `content` is the JSON document, as text. */
  message: { content: Content; calls?: readonly ToolCall[] };
  finishReason: "stop" | "tool-calls" | "length" | "refusal";
  usage: Usage;
  model?: string;
  providerState?: ProviderState;
  /**
   * How the provider weighed each option, per top-level field, where it said so.
   * Reported, never derived: a wire that states none leaves it absent, and nothing
   * here turns logprobs into it.
   */
  probabilities?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ModelError extends Failure {
  code: "auth" | "rate-limit" | "context-length" | "cancelled" | "provider" | "failed"
    | "unsupported"; // this model cannot answer this request; `message` says what is missing
  // status, errorType, errorCode: unchanged
}
```

The four modes are one field:

| Mode | `output` | Who honours it |
| --- | --- | --- |
| (a) free text | absent | every LLM wire; Jev fails `unsupported` |
| (b) schema-constrained JSON | an object schema | each LLM wire's native structured output; Jev if every field is a described choice or a boolean |
| (c) a choice decision | an object whose fields are `anyOf` described `const`s (or `enum`) | Jev natively; every LLM wire too, as (b) |
| (d) "some JSON, you pick the shape" | `{ "type": "object" }` with no `properties` | chat/Responses wires as `json_object`; Anthropic (no such mode) and Jev fail `unsupported` |

(c) is not a separate mode. It is (b) with a particular schema. That is the whole trick, and it is
why Jev needs no special case. A decision is a JSON Schema whose fields enumerate described answers,
which zod writes for you:

```ts
z.union([z.literal("PLAIN").describe("…"), z.literal("FILTER").describe("…")]).describe("Which kind of query?")
// → { "anyOf": [{ "type": "string", "const": "PLAIN", "description": "…" }, …], "description": "Which kind of query?" }
```

(Checked against the zod 4 already in `package.json`. `z.object` also emits `required` for every
field and `additionalProperties: false`, which is what strict modes require.)

### The typed result: `defineOutput`

`defineTool` already turns a zod schema into a JSON Schema for the wire and a validator for what
comes back. An answer's shape is the same pair, so it gets the same declaration (`defineX` is inert):

```ts
// src/model/output.ts, exported from `aglib/model`
export interface Output<T> {
  /** JSON Schema, for `ModelRequest.output`. */
  readonly schema: JsonValue;
  /** The answer, checked against the schema it was asked for. */
  parse(response: ModelResponse): Result<T, OutputError>;
}

export interface OutputError extends Failure {
  code: "invalid-output" | "refused" | "truncated";
  /** What the model actually said, so a caller can log it. */
  text: string;
}

export function defineOutput<TSchema extends z.ZodType>(input: { schema: TSchema }): Output<z.output<TSchema>>;
```

`parse` reads `textOf(response.message.content)`. It maps a `refusal` finish to `refused` and a
`length` finish to `truncated`, then runs `JSON.parse` and `schema.safeParse`. Usage is never part
of the error, because the caller is still holding the `ModelResponse`. **A paid call that produced
an unusable answer can therefore still be recorded.** aglib does not retry an invalid answer:
whether a second paid call is worth it is the caller's decision, as with every other refusal.

### What each adapter does with `output`

| Adapter | Sends | `probabilities` |
| --- | --- | --- |
| `openai-compatible` | `response_format: { type: "json_schema", json_schema: { name: "output", schema, strict: true } }`; `{ type: "json_object" }` for a schema with no `properties` | absent |
| `createOpenRouterModel` | as above, **plus `provider: { require_parameters: true }`**, so OpenRouter routes only to upstreams that honour it | absent |
| `openai-responses` | `text: { format: { type: "json_schema", name: "output", schema, strict: true } }` | absent |
| `anthropic` | `output_config: { format: { type: "json_schema", schema } }`, merged with the `output_config.effort` it already sends; a schema with no `properties` fails `unsupported` | absent |
| `typesafe` (new) | `questions` translated from the schema (below) | from `answers.*.probabilities` |
| `fake` | `FakeResponse.text` is already the JSON document; gains `probabilities?` | as scripted |

No adapter rewrites a schema to make it pass a provider's strict subset. A schema the provider
refuses comes back as that provider's 400, with its own `errorType` and `errorCode`. Making the
schema acceptable is the caller's job, and the conformance suite says so. The subsets genuinely
differ. Example (b) below uses `maxItems: 4`, which OpenAI takes and Anthropic does not list.
`anyOf` of `const` is the only described-choice spelling all three accept, if OpenAI's `const` is
confirmed. The one exception is zod's `$schema` meta keyword: it constrains nothing, and an adapter
may strip it if a provider is found to refuse it.

Two things must be checked live before this ships. They go in the opt-in `AGLIB_LIVE_MODEL=1`
cases, not the hermetic suite:

- that OpenAI strict mode accepts `anyOf` of described `const`s;
- that OpenRouter with `require_parameters` routes the detector's DeepSeek and GLM models to an
  upstream that honours `strict`.

### The Typesafe adapter

`aglib/model/adapters/typesafe` → `createTypesafeModel({ apiKey, model, baseUrl?, fetch? })`.
`baseUrl` defaults to `https://api.typesafe.ai`; set it to `https://openrouter.ai/api` with model
`~typesafe/jev-latest` to bill through OpenRouter, which carries this same wire.

**Request.** It refuses before sending, as `unsupported`, when:

- `output` is absent ("Jev does not write text");
- `tools` is non-empty;
- any message holds an image or a file;
- the schema is not an object of fields it can express.

The fields it can express are:

| Schema field | Jev question | Answer in `content` |
| --- | --- | --- |
| `anyOf`/`oneOf` of `{ const: string, description? }`, or `enum: string[]` | `{ type: "choice", criteria: { [const]: description ?? null }, instructions: field.description }` | `answers[k].choice` |
| `type: "boolean"` | `{ type: "noul", instructions: field.description }` | `answers[k].noul >= 0.5` (probabilities `{ true: p, false: 1 - p }`) |

- **State.** `state` is the conversation's text. A single user message becomes its text. Several
  messages become `[{ role, text }]`. A leading system message becomes part of `state` too, because
  Jev has no instruction channel above the question and its docs say domain context belongs in
  `state`.
- **Instructions.** The root schema's `description`, if present, goes before every question's
  `instructions`.
- **Ignored controls.** `effort`, `temperature`, `maxOutputTokens` and `cacheAfter` are declared
  `ignored` in the suite's `Wire`. Jev has none of them.

**Response.**

- `content` is `JSON.stringify` of the answers, in schema field order, and is yielded as one
  `text.delta`.
- `usage` is `{ inputTokens: input_tokens, outputTokens: output_tokens }`, with **no `costUsd`**.
  Jev states none, and this package never derives one.
- `model` is the versioned id the response names.
- `probabilities` comes from each answer.
- `finishReason` is `stop`.

**Errors.** The shared retrying `fetch` covers 429, 529 and other 5xx, and honours `Retry-After`. It
does not read `retry-after-ms`, so a Jev 429 waits by whole seconds. 422 is `failed`, carrying
`detail` in the message.

**Scores.** The `score` question type is not mapped. Nothing here asks for one yet, and its answer
(a probability-weighted level) does not fit a JSON Schema type without a custom keyword. It can be
added when a consumer needs it.

### What the conformance suite holds every adapter to

`aglib/model/conformance` gains the vocabulary and the cases. Most of what this proposal promises
lives here rather than in prose:

- `ModelScript` gains `{ kind: "output"; value: JsonValue; probabilities? }`, an answer to a shape.
- `SentRequest` gains `output?: JsonValue`, the schema the request carried, translated back.
- `ModelUnderTest` gains a declaration of what it answers, because today the suite assumes every
  model writes text and calls tools, and Jev does neither:
  `answers: { text: boolean; tools: boolean; output: "schema" | "choices" | "none" }`. A case is
  never given a script the declaration rules out, which is already the rule for `reasoning`.
- New cases:
  1. *A request for a shape carries that shape to the provider*. `sent().output` deep-equals the
     schema, so a wire that drops it fails.
  2. *An answer to a shape arrives as one JSON document in the message*. It parses and equals the
     script.
  3. *A request this model cannot answer fails `unsupported`, and nothing is sent*. This covers free
     text and tools on Jev, a non-choice schema on Jev, and `output` on any wire that declares
     `"none"`.
  4. *Probabilities the provider stated reach the caller; a wire that states none does not invent
     them*. This is the pair the `costUsd` cases already make.

### Accounting

**Nothing new.** The answer to "how is a structured call paid for?" is the same `Usage` on the same
`ModelResponse`. Under the existing doctrine:

- **Jev's cost is the host's to price.** The response states tokens, not dollars, and Jev's
  published rate goes in the host's own table (`$0.042/M` input, `$0` output) beside every other
  model's. A Jev call billed through OpenRouter would carry `usage.cost` if OpenRouter adds it. That
  is unverified, and the adapter takes `usage.cost` only if it is there.
- **Inside a run** (a tool that calls Jev, say), commit a `model.finished` entry with a `purpose`,
  exactly as compaction does. The host's ledger trigger and telemetry spans already read it.
- **Outside a run** (the search bar), the caller holds `response.usage` and `response.model` and
  writes the ledger row itself. §5 says what that means for recruitment-os.

## 4. Worked examples

```ts
import { defineOutput, type Model } from "aglib/model";
import { createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { createTypesafeModel } from "aglib/model/adapters/typesafe";
import { z } from "zod";

// The host's own drain; aglib keeps `collect` internal (model.ts says why).
const answered = async (generation: ReturnType<Model["generate"]>) => {
  let step = await generation.next();
  while (!step.done) step = await generation.next();
  return step.value;
};

const deepseek = createOpenRouterModel({ apiKey, model: "deepseek/deepseek-v4.1-flash" });
const jev = createTypesafeModel({ apiKey: typesafeKey, model: "jev-1.13.0" });
```

**(a) Free text, unchanged.**

```ts
const result = await answered(deepseek.generate({ messages: [{ role: "user", content: "Summarise this thread: …" }] }));
if (result.ok) console.log(textOf(result.value.message.content), result.value.usage);
```

**(b) Schema-constrained JSON from an LLM.**

```ts
const Searches = defineOutput({ schema: z.object({
  searches: z.array(z.object({
    keywords: z.string(),
    type: z.enum(["person", "company", "job"]).nullable(),
    place: z.string().nullable(),
  })).min(1).max(4),
}) });

const result = await answered(deepseek.generate({ messages, output: Searches.schema, effort: "low" }));
if (!result.ok) return result;                   // ModelError: auth, rate-limit, …
record(result.value.usage, result.value.model);  // paid either way
const searches = Searches.parse(result.value);   // Result<{ searches: … }, OutputError>
```

**(c) A decision, on Jev or on anything else.**

```ts
const Route = defineOutput({ schema: z.object({
  operation: z.union([
    z.literal("PLAIN").describe("A name, a skill, a title or a phrase to match as typed."),
    z.literal("FILTER").describe("A plain lookup naming a kind of record and/or a place."),
    z.literal("COMPLEX").describe("Needs reasoning: a question, negation, a date, a comparison."),
  ]).describe("A recruiter typed a search query. Which kind of query is it?"),
}) });

const request = { messages: [{ role: "user" as const, content: query }], output: Route.schema };
const fromJev = await answered(jev.generate(request));       // native: one `choice` question
const fromLlm = await answered(deepseek.generate(request));  // the same request, as response_format
// fromJev.value.probabilities?.operation → { PLAIN: 0.02, FILTER: 0.97, COMPLEX: 0.01 }
// fromLlm.value.probabilities           → undefined: not reported, so not invented
```

**(d) Some JSON, whatever its shape.**

```ts
const Anything = defineOutput({ schema: z.looseObject({}) }); // { type: "object" }, no properties
const result = await answered(deepseek.generate({ messages, output: Anything.schema })); // json_object
// On jev or anthropic: err({ code: "unsupported", … }) before any request is sent.
```

## 5. recruitment-os's search detector through it

Today `jev.ts` builds `questions` by hand, POSTs with `fetch`, and reads `answers.*.choice`. It has
no retry, no abort, no usage recording and no way to fall back. Through this design it becomes the
following:

```ts
// agent/src/runtime/search/detect.ts (sketch; recruitment-os's to write)
function detection(tokens: readonly string[], types: readonly string[]) {
  const span = (i: number, n: number) => z.literal(`${i}:${i + n}`).describe(`place name "${tokens.slice(i, i + n).join(" ")}"`);
  const spans = tokens.flatMap((_, i) => [1, 2, 3, 4].filter((n) => i + n <= tokens.length).map((n) => span(i, n)));
  return defineOutput({ schema: z.object({
    operation: z.union([/* PLAIN, FILTER, COMPLEX as in (c) */]).describe("…"),
    type: z.union([z.literal("none").describe("no record kind is named"),
      ...types.map((t) => z.literal(t).describe(TYPE_HELP[t] ?? t))]).describe("…"),
    type_word: z.union([z.literal("NONE").describe("no word is a record kind"),
      ...tokens.map((t, i) => z.literal(String(i)).describe(`the word "${t}"`))]).describe("…"),
    place: z.union([z.literal("NONE").describe("no place is named"), ...spans]).describe("…"),
  }) });
}

export async function detect(query: string, signal: AbortSignal): Promise<Detected> {
  const tokens = query.trim().split(/\s+/);
  const Detection = detection(tokens, TYPES);
  const result = await answered(models("JEV").generate({
    messages: [{ role: "user", content: query }], output: Detection.schema, signal,
  }));
  if (!result.ok) return plain(query);                    // cancelled (stale), rate-limit, …: the plain search already ran
  await spend.record({ purpose: "search-detect", model: result.value.model, usage: result.value.usage });
  const read = Detection.parse(result.value);
  if (!read.ok) return plain(query);
  const sure = result.value.probabilities?.operation?.[read.value.operation] ?? 1;
  if (sure < 0.8) return plain(query);                     // wrong structure is worse than missing structure
  return rebuild(tokens, read.value);                      // jev.ts's keyword reconstruction, unchanged
}
```

- **The signal is what makes the debounce work.** The caller passes
  `AbortSignal.any([typingChanged, AbortSignal.timeout(1000)])`. The adapter's retries end the moment
  it fires, and the generation reports `cancelled`, not a late answer.
  The 180 s retry ceiling is for agents; a search box bounds it with its own signal.
- **Falling back is a `Model` that closes over others.** `INTERFACE.md` already says so. Given
  `unsupported` or a `provider` failure from Jev, try `deepseek` with the *same request*. Nothing
  about the request changes, which is the point of (c) being (b).
- **Recording spend is the host's call, and today it has nowhere to go.** A call outside a session
  can reach `query_v1.spend` only as an `account:*` effect. recruitment-os needs to:
  - add a ledger path for sessionless paid calls (a `runtime.paid`-shaped row with a `purpose`);
  - add `"typesafe"` to `PROVIDERS`, with a `Price` of `{ input: 0.042, output: 0 }` per million.

  `savedEstimate` then prices it like any other wire that states no cost. At one call per typing
  pause that is a lot of rows at $0.00006 each. Whether to record each call or a per-minute sum is
  the host's choice.
- **Telemetry.** recruitment-os's spans are a projection of log entries, so a sessionless call emits
  nothing unless the detector emits an `$ai_generation` itself from `response.usage` and `.model`.
- **Before switching.** Re-run the 52-query realistic suite through the adapter. The adapter sends
  `state` as the query string where `jev.ts` sent `{ query }`, and the effect of that on accuracy has
  not been measured.

## 6. What changes in the documents

The brief asked for "what changes in SPEC.md". That file is now split, so this lists the edits by
document.

- **`INTERFACE.md`, "Choosing a model":** a new subsection, *An answer of a given shape*. It says
  `output` is JSON Schema, that it is sent or refused and never dropped, that a decision is a schema
  of described choices, `defineOutput`, `probabilities` as an observation, and Jev as a provider that
  answers only shapes.
- **`INTERFACE.md`, "Failures":** `unsupported` joins the codes. A request a model cannot answer
  fails before anything is sent.
- **`INTERFACE.md`, "What a run consumed":** one sentence. A provider that states tokens and no cost
  (Jev) leaves `costUsd` absent like any other, and the host prices it.
- **`ARCHITECTURE.md`, "The four ports":** the `model` row adds "an answer of a requested shape, or
  a typed refusal".
- **`ARCHITECTURE.md`, "What an adapter must prove":** a model subject declares what it answers.
  This is the model suite's equivalent of the sandbox declaring its isolation.
- **`PRODUCT.md`:** no change. The inclusion test is met by the conformance suite (every adapter
  held to `output`) and by a recipe (below).
- **`REFERENCE.md`:** regenerated, adding `defineOutput`, `Output`, `OutputError` and
  `aglib/model/adapters/typesafe`.

**The consumer the gate demands.** `exports-consumed` needs a recipe to import `defineOutput` and
`createTypesafeModel`. `recipes/coding-agent` already says its job is "our decision on every call the
agent asks about", and its `decide` today is `() => ({ action: "execute" })`. The proposal makes
that `decide` classify each requested command with a described-choice `Output`: `read-only`,
`edits the workspace`, `reaches the network` or `destructive`. It runs on Jev when
`TYPESAFE_API_KEY` is set and on the recipe's OpenRouter model otherwise. That is the same request on
two providers, tested hermetically with the fake. It is a demonstration, not a security boundary:
the sandbox stays the boundary, and the README says so.

## 7. Migration

- **aglib (0.7.0, a minor: changed contract).**
  - `output` and `probabilities` are optional additions. A caller that sets neither sees no change.
  - The breaking parts are `ModelError.code` gaining `unsupported`, which breaks exhaustive
    switches, and the conformance subject requiring an `answers` declaration, which breaks adapters
    held to the suite outside this package.
  - There are no aliases or shims.
- **Model wrappers.** Any `Model` that wraps another must forward `output` and carry `probabilities`
  through. A wrapper that rebuilds the request field by field silently drops the new field, which is
  the defect this design forbids.

  recruitment-os's `paired()` and `completed()` around the Anthropic model are the ones to check.
- **recruitment-os.** Bump to 0.7.0, handle `unsupported` where it switches on `code`, add the
  `typesafe` provider and price, and write the detector against the port. The hand-rolled
  client lives in the eval directory, not in recruitment-os, so there is no old way to delete
  there. The eval's `jev.ts` can stay as the frozen record of what was measured.

## 8. Rejected alternatives

1. **A separate `Decider` port for decision models.** That would be two ports for one fact: a request
   for an answer of a given shape. Every LLM can answer the same decision, the detector eval
   compared exactly that, and failover from Jev to an LLM would need a translation layer. The name
   also collides with `Decide`, the permission callback.
2. **A request discriminator, `kind: "text" | "json" | "choices"`.** A choice *is* a JSON Schema
   enum. Two spellings of one request would let Jev accept one and LLMs the other, and that is the
   special case the brief asked to avoid.
3. **Tool-call-as-output (forced `tool_choice`) as the portable mechanism.** Every wire here has
   native schema output, so this would emulate something the provider offers. It would also put a
   call the loop is meant to execute into the log as an answer, and it would add `tool_choice` to the
   port for this alone.
4. **A parsed `output` value on `ModelResponse` beside `content`.** That would be a second field for
   a value `content` already determines. The typed value belongs to `defineOutput.parse`, which also
   owns validation.
5. **aglib validating JSON Schema itself (ajv or similar).** That adds a dependency and a second
   schema language. The caller's zod schema validates, as it already does for tool arguments.
6. **Mode (d) as "provider infers the schema", with an inferred-schema field.** No provider sells
   this; OpenAI's Decisions API takes caller-defined questions. Free-form JSON is a permissive
   schema.
7. **Deriving Jev's cost from its published rate, or deriving probabilities from LLM logprobs.**
   Both are numbers this package would be making up. `PRODUCT.md` forbids the first, and the second
   is a simulated guarantee.
8. **Exposing Jev's `confidence` beside `probabilities`.** It is a documented function of
   `probabilities`, so it would be a second field for one value.
9. **Native spans in the port.** No provider has them, and Jev's own docs say to enumerate
   candidates as choices.
10. **Jev through `createOpenRouterModel`.** OpenRouter carries Jev on Typesafe's wire, not chat
    completions, so it is `createTypesafeModel` with OpenRouter's base URL.
11. **Silently ignoring `output` on a wire that cannot honour it.** That would be the
    caller-control-going-nowhere defect the conformance `Wire` declaration exists to catch, and here
    it is worse: the caller would parse prose.

## 9. Open decisions for Adam

1. **Where the Jev adapter lives.** The recommendation is in-package, consumed by the coding-agent
   `decide` recipe. The alternative is that the adapter lives in recruitment-os and runs
   `aglib/model/conformance`. That needs no recipe change, but then aglib doesn't take Jev.
2. **`probabilities` on `ModelResponse`.** The recommendation is to keep it. The detector should
   drop low-confidence structure, and the number cannot be reconstructed later. The alternative is
   to leave it out until a measured threshold exists.
3. **How Jev's `state` is mapped.** The proposal sends the conversation's text. The alternative is
   to let a caller pass a JSON object as `state` (the eval sent `{ query }`). That would need a JSON
   content part, which is a bigger change. Decide after re-running the realistic suite through the
   adapter.
4. **`defineOutput` versus a one-call helper.** The proposal is the inert declaration plus the host's
   own drain, matching `defineTool` and the reason `collect` stayed internal. The alternative is
   `runModel({ model, request, output }) → Result<{ value, response }>`, which is one more value
   export.
5. **The OpenAI Decisions API.** Add an adapter when its contract is published, or rely on
   `gpt-6-luna` with structured output (mode (c) over the Responses wire) until then.

## Sources

All read 2026-10-05. No live provider call was made for this proposal.

- **Typesafe Jev:**
  - https://docs.typesafe.ai/api
  - https://docs.typesafe.ai/models
  - https://docs.typesafe.ai/primitives/choice
  - https://docs.typesafe.ai/confidence
  - https://docs.typesafe.ai/concepts/state
  - https://docs.typesafe.ai/model-jaggedness/jev-1.13
  - https://docs.typesafe.ai/cookbooks/parallel_questions
  - https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook
  - https://docs.typesafe.ai/sdk/python/usage
  - https://docs.typesafe.ai/sdk/python/api/retries
  - https://api.typesafe.ai/openapi.json
- **OpenAI Decisions API and Luna:**
  - https://openai.com/index/devday-2026-recap/
  - https://developers.openai.com/api/docs/models/gpt-6-luna
  - https://developers.openai.com/api/docs/changelog
  - https://developers.openai.com/api/reference/resources/decisions (404)
  - https://github.com/openai/openai-python/releases
  - https://github.com/openai/openai-node/releases
  - https://the-decoder.com/openai-expands-codex-and-its-api-at-devday-with-security-scans-a-decisions-api-and-ultrafast/ (secondary; latency only)
- **Structured outputs:**
  - https://developers.openai.com/api/docs/guides/structured-outputs.md
  - https://developers.openai.com/api/reference/resources/responses/methods/create.md
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md
  - https://platform.claude.com/docs/en/api/messages/create.md
  - https://openrouter.ai/docs/guides/features/structured-outputs.md
  - https://openrouter.ai/docs/guides/routing/provider-selection.md
  - https://openrouter.ai/docs/guides/administration/usage-accounting.md
  - https://ai.google.dev/api/generate-content
  - https://docs.vllm.ai/en/latest/features/structured_outputs.html
- **Local evidence:**
  - `recruitment-os-detector-eval/work/search-detector-eval/{jev.ts,REPORT.md}` (Jev p50 227 ms / p95 281 ms, about 1,360 input tokens, $0.06 per 1,000 calls)
  - recruitment-os `main` at `2e2c4073` (ledger, telemetry, model construction, search path)
