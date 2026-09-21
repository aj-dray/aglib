# INTERFACE — the outward-facing surface, and what shapes it

Everything an application touches: the SDK, and the shapes a CLI, HTTP API or UI is built from.

## The SDK

The first useful agent fits on one screen — [`recipes/native-agent`](../recipes/native-agent/README.md)
is a real one. Imports perform no I/O. Defaults open no connection, database, process or sandbox.
Every stateful dependency is passed in.

Construction uses a small grammar: `defineX` creates an inert validated declaration, `createX`
creates a stateful composition, `runX` performs immediate work.

Adding durability changes the composition around the agent, not the agent. The same definition that
ran under `runAgent` runs with a store, and what it gains is a durable log and resume.

## Streamed output

Text deltas retain optional provider phase (`commentary` or `final_answer`) through the native
harness. A provider that supplies no phase leaves it absent. Phase describes the provider output,
not a delivery destination; applications decide how to present it. Reasoning remains a distinct
stream and is never relabelled as commentary. Provider continuation state preserves the original
message items, including their phases.

## Lifecycle hooks

`Agent.hooks` is an ordered list of named, trusted application callbacks: `beforeRun`, `beforeModel`, `afterModel`, `beforeStop`, and `afterRun`. No script runner or second workflow state is involved. Model hooks run only at model boundaries exposed by a harness; the native harness exposes every generation, while an external harness owning its loop need not do so. `afterModel` receives the `ModelRequest` that was sent, so an application can observe the exact call without wrapping `generate`. The log does not store that request: the prefix is a `run.context` entry the application commits once, the transcript is the rest of the log, and `assistant.generation.turn` is the per-call slice that sat after the cache boundary.

`beforeStop` sees the proposed outcome. It may return `{ input }` to continue a normally completed run, or `{ deliveries }` to deliver with the terminal commit. Each named hook can add input once per run, recorded as `hook.input` in the existing log; resuming that run does not reset the allowance. Cancellation, deadlines and failures cannot be continued. Nothing creates another session or queued arrival. Deliveries are collected only when no hook continues the run.

`afterRun` observes the final result after the terminal write, including failures. Its callbacks all run even if one throws; observer errors appear as `hook.error` updates and do not rewrite the run's outcome. Before-boundary callback errors fail the run. Resource cleanup belongs in `afterRun`, not in a stop veto. Hook names must be unique within an agent.

## The two context slots

An application places context by lifetime, and the loop puts it on the right side of the cache
boundary:

- **`context.run`** sits inside the cached prefix and is fixed for the run — remembered facts, a
  skill index, a tenant profile.
- **`context.turn`** sits after it and is for one request — retrieved documents, the clock. It may
  be a function, evaluated when each request is built, so a long activation does not keep the
  value from its first generation.

This is the seam every memory system reaches the library through, and it is deliberately the only
one besides tools. Getting the split right is the loop's job because only the loop knows where the
prefix ends; a run-scoped fact written mid-run therefore applies from the next run, because
rewriting a cached prefix invalidates every following turn.

The cached prefix includes the committed conversation as well as instructions and run context. Its boundary advances after each user input and tool result, stopping before the trailing turn context. The loop hands that boundary to the model as `cacheAfter`, and each wire does with it what its provider needs; [Choosing a model](#choosing-a-model) says which wires mark it and for which models.

The turn context is projected as a system message after the conversation, and each wire sends it as its provider can cache around. The Anthropic wire keeps it a system message inside `messages`, leaving the hoisted `system` field to the leading run. The chat-completions wire (`createOpenAiCompatibleModel` and `createOpenRouterModel`) sends it as a `user` message with its text unchanged: OpenRouter folds every `system` message into Gemini's single `systemInstruction`, which Gemini's implicit cache treats as immutable, so a request ending in a system message reads nothing from cache even when repeated byte for byte — 0 tokens of a 15,138-token prefix — where the same line as a trailing user message reads 12,189, and DeepSeek behaves the same way. Only the role changes; a leading system message stays `system`.

## Keeping a long conversation in budget

`createCompactionHook` in `Agent.hooks` folds older turns into a summary before a model call once the estimated request
passes `maxInputTokens`. The cut lands on a **drained** boundary — a point where every call an
assistant turn asked for has its result — so a call is never separated from its result, and a run
that has been calling tools for an hour without stopping has somewhere to cut like any other.
Nothing is deleted: the latest summary replaces an older prefix in model context and appears before the retained chronological tail. The cut keeps about 20,000 estimated recent tokens (or 40% of a smaller budget), rather than a fraction of bookkeeping entries. A single oversized exchange can be summarized whole; calls and results are never separated. Repeated compaction incorporates the previous summary once, alongside newly folded messages.

`maxInputTokens` is the application's budget rather than a provider fact, and it belongs below the
input window of the model that answers with room for the turn after the fold. The summary is written
by the hook's explicit `model`. Its short checkpoint preserves instructions, evidence, completed effects and unresolved work, including tool arguments and outcomes. Empty, truncated or non-shrinking output never replaces history. A fold that cannot bring the request under budget fails explicitly. Provider input usage anchors the estimate until a compaction changes the context; new messages and tool schemas are estimated without requiring a tokenizer for each provider.

## What a run consumed

A run answers with `usage` on every outcome, because a run that burned a thousand tokens and then failed burned them. It is summed from the `assistant` and `model.finished` entries the activation committed, so a harness reports no total of its own and a cancelled run still says what it cost.

`Usage.costUsd` comes with them where the provider states a cost — OpenRouter does, on every
response — because that is an observation like the counts beside it, and no table an application
keeps could reconstruct it for a router that picks its upstream per request.

**A rate table is not here, and neither is a ceiling.** The counts are the fact; the rates that turn them into money move faster than a release and belong to the deployment. A spend limit would have to read those rates, which means taking a function from the caller and then defending against it — and what to do when a run gets expensive is policy besides: the two applications that wanted a ceiling wanted it to stop at different moments. An application prices its own log, from a table it holds, in one line.

## Sending, and running what was claimed

A run is working one of two things, and the shape says which:

```ts
runAgent({ agent, store, sessionId, input: "what is the September balance?" });  // a caller sends
runAgent({ agent, store, claim });                                              // a worker runs
```

A claim is what `store.next()` or `store.interrupted()` handed back, passed whole. It carries the
session, the position to write from, and the deliveries to consume, so none of them can be lined up
wrongly — which they were: `takePending` was only ever `claim.pending.length` and the position only
ever `claim.seq`, and forgetting the first left the input queued for ever. A worker may add input of
its own alongside a claim, and one thing ever does: orientation for a harness whose protocol has no
system prompt.

## Resuming what a process was doing

`store.interrupted()` answers the question `next` does not: which session was being worked when a
process stopped existing. It claims one the same way, and reports it with an empty queue.

**A claim with an empty queue is a resumption.** Nothing opens it — the input this conversation began
with is already an entry, so replaying it would begin it twice — and the tool call that already had
its effect is read from the log rather than asked for again.

Only a harness declaring `recovery: "history"` is given one. A harness declaring `"none"` cannot be
started on a conversation it cannot see, so the run it was handed is **ended**: the interrupted
activation is committed as `run.finished` with a `no-recovery` failure, and `beforeStop` fires,
so whoever was waiting on that session is told rather than waiting for ever. Refusing without
writing was the obvious thing and it was wrong — the activation stayed open, and `interrupted` handed
the same session back every claim window for the rest of its life.

## Choosing a model

A model is a **value**, not a name. `createAnthropicModel({ apiKey, model })` is the provider, the
credential and the model together, and choosing a different one is choosing a different `Model` —
which is already how the loop hands compaction a cheaper one. Routing between providers is a record
lookup the application writes, because it owns the catalog and the credentials; failover is a `Model`
that closes over other `Model`s.

There is no model name on a request, and its absence is the design. A name has to be resolved, and
resolving is what goes wrong: the one application with a name field to use packed provider and model
into it as `provider/model`, then had to split it back out — ambiguously, because provider ids
contain slashes themselves. One field, two facts.

**Names leave this library as observations and never enter it as selections.** `ModelResponse.model`
says what actually served and `entry.generation.model` records it, which is what an application
prices a run from. `effort` stays on the request, because how hard to think is a knob over one call
rather than part of which model this is.

A tool declares `ToolSpec.concurrent: true` when its calls may run alongside adjacent concurrent
calls in one batch, up to the executor's `maxConcurrency` of eight; the library verifies nothing
about that claim.

A configured model that accepts asynchronous client tools says so with `Model.asyncTools: true`.
The application may then declare an individual `ToolSpec.async`; nothing infers this from a tool's
`concurrent` declaration or a model name. A completed asynchronous call can arrive before its model
generation ends. The native harness commits the call and `tool.started` before running it, lets the
generation continue, and later commits the real result under the original call id. A call still
running is left open in model context. If the process dies, recovery closes it as unreported and
does not repeat its effect.

An ordinary synchronous tool still occupies its own execution lane until it returns. Mark work
asynchronous only when both the selected model and the tool declare that contract; otherwise put
long independent work in its own session. The runtime does not pretend that partial batch commits
make one arbitrary blocking function interruptible.

The OpenAI Responses adapter uses the official SDK's persistent WebSocket. One configured model
reuses that transport across turns and concurrent sessions. It leases the connection's bounded
`stream_id` lanes and reuses a lane only after its terminal response event. A locally cancelled
generation releases its caller immediately, quarantines that lane from reuse, and discards its late
events. That connection accepts no new work and closes after its other active lanes finish. If every
lane is occupied, a new connection accepts later work while the old one drains. Every request still
carries the durable projected history, so transport reuse is not a second conversation store.
`openai` and its Node `ws` transport are optional peer
dependencies of aglib and dependencies of the consuming application. Other subpaths neither load
nor require them. Its concrete model has `close()` because the application that caches it also owns
those connections.

`ModelGeneration.steer` is an optional provider capability. The native harness first commits new
`turn` input, then offers those user messages to the active generation. Acceptance means the
provider applied the input to a successor generation. Rejection does not cancel the current
generation: it finishes, and the durable input is read at the next ordinary model boundary.

### Cache breakpoints

`cacheAfter` ends the cacheable prefix, and a provider that caches only on request is told where. The Anthropic adapter marks `cache_control` on the first and the last leading system block and on the block the boundary ends on: the last mark makes a conversation's own prefix reusable across its turns, and the first makes the standing instructions every conversation shares reusable across conversations, so an agent serving many callers pays for what differs and not for what they have in common. `createOpenRouterModel` marks the same three places, as `cache_control` on a text part, for models whose id begins `anthropic/`, because a Claude served through OpenRouter caches nothing without one and reads and writes its whole prompt at full price every turn. No other model there is sent a mark: every other provider it routes to caches a repeated prefix by itself, whether those providers ignore a mark is not something OpenRouter documents, and a strict endpoint can refuse a field it does not know. `createOpenAiCompatibleModel` sends none unless its `cacheBreakpoint` option names the endpoint's spelling, and the Responses adapter sends none because OpenAI caches automatically. What was read and written comes back as `cacheReadTokens` and `cacheWriteTokens`, disjoint from `inputTokens`, on every wire that reports them.

### Waits

A provider that has not begun to answer can fail a request two ways, and only one is a refusal. A rate limit, an overloaded upstream, a connection that never opened, or OpenRouter's credit being reserved by the account's own other requests still in flight is the provider saying *not yet*: nothing about the request was wrong, and it clears on its own. The HTTP adapters — Anthropic, OpenAI-compatible and OpenRouter — wait and send such a request again before the first delta is yielded, in one place in the model layer, and a caller sees one generation either way.

What counts as a wait is a status or structured metadata, never a message: 408, 409, 425, 429, any 5xx and a transport error on every HTTP wire, and on `createOpenRouterModel` a 402 whose body's `error.metadata.reason` is `in_flight_budget_exhausted`. A plain 402, 400, 401, 403, 404, 413 or 422 is a refusal — an account with no credit, a context that does not fit, a bad credential, declined content — and is reported at once, because sending the same request again asks for the same answer.

The bounds: at most four retries per request. A wait is `Retry-After` when the provider sends one, as seconds or an HTTP date, honoured up to 120 s; otherwise full-jitter backoff over a ceiling that starts at 1 s and doubles each retry, never past 30 s. No request waits more than 180 s in total, and a wait that would pass that is not taken. An aborted `signal` ends a wait at once and the generation reports `cancelled`. When the retries run out the error keeps a retryable code — `rate-limit` for 429 and the in-flight 402, `provider` for the rest — because the provider never said the request was wrong, and a caller with more time than the adapter is told so.

A failure after the first delta is not retried by the adapter: partial output has already reached the caller, and whether to ask again is the loop's decision, which continues past a retryable failure when it has new input to send. The Responses adapter holds a WebSocket rather than making an HTTP request per generation, so neither this nor the OpenAI SDK's own HTTP retry sees its generations; a `rate_limit_exceeded` event there fails the generation as `rate-limit`, retryable, and is not retried.

## Waiting for work

`store.watch(watcher)` is an optional wake line: it says a session moved and whether it now has
work owed, and the only correct response is to ask the store what it says now. A caller keeps a
heartbeat regardless — nothing about a wake is guaranteed except that the change is readable by the
time it arrives — so the feed buys latency, not certainty. A store with no push channel omits the
method and its callers poll, which is the difference between a message reaching a busy service in
milliseconds and in half a second.

## Events, and every other surface

A run is an `AsyncIterable` of ephemeral updates with a `result` promise. Committed entries carry a
sequence number; deltas do not and are never recovery state.

That single pair — **entries with a cursor, deltas without** — is what every outward surface is
built from, and `render` is the package's own answer for one medium: the fold from that pair to
lines a person reads, so the three recipes share one instead of writing three that drift. A CLI
prints deltas. An HTTP API streams entries after `?after=N`. A web UI resumes
from its last sequence number after a reconnect and may have missed provisional text, never
committed content. A Slack or email bridge translates at the edge. None of them invents a second
protocol, and only their ability to resume differs.

## Sending into a session

An application delivers input to a session the same way an agent does — one `append` that commits the sender's entries and the recipient's input together. A delivery names **where in the recipient's loop it should land**:

```ts
await store.append({
  sessionId: sender, expectedSeq, entries,
  enqueue: [{ sessionId: target, input: "the build is broken", from: sender, priority: "turn" }],
});
```

- **`interrupt`** — the running activation ends, so the next one begins with this. Its uncommitted work is lost; everything already committed stays.
- **`turn`** — folded into the activation already running, before its next model call. Nothing in flight is lost. Immediately, if nothing is running.
- **`next`** — at the start of the recipient's next activation. The default.

Three places, each one thing. A harness that cannot reach one falls back to a **later** place, never an earlier one: a loop with no safe point mid-turn cannot do `turn`, so the message waits rather than the activation being ended instead. An application answering a sender tells it which place was reached, so "later than you asked" is visible rather than silent.

Input carries `from` onto the recipient's `run.started` — `{ kind, id }`, naming what sort of sender it was and which one. aglib mints exactly one kind, `"session"`; a person, a channel, a schedule and a webhook are the application's words, because only the application can close that list. It is provenance the log keeps, and an application reads it to tell a person typing from a peer agent from a routine firing, and to see that it has already answered one that arrived twice.

`agent.attribution` decides whether the model reads it too: with it on, each arrival is prefixed `[from kind id]`. Off by default, and the default is the common case — an application that renders a sender into the input it delivers can say it in words its agent knows, and a second name beside that one is a session id the model can do nothing with.

## Where an agent's hands are

A sandbox is requested, not described. `isolation: "required"` is either enforced or refused: the
local provider runs with the host's authority and says no, the Docker provider hands back a
container, and a hosted provider is an adapter an application writes, held to `sandbox/conformance`
like the two here.
The outbound posture is stated at creation and never defaulted, and a provider that cannot enforce
the one it was given refuses before anything is provisioned.

A credential is passed as a `Secret` rather than as environment, and the sandbox answers `secrets`
with what became of it: `"substituted"` means the box holds a reference and the value is put in at
egress, to the hosts that secret named — the agent can spend the credential and cannot read it.
`"plain"` means the value is in the environment, where anything running there can read it, and a
caller handing a long-lived token to code it did not write can decline on that answer. The local and
Docker providers say `"plain"`; a hosted provider that keeps the value out of the box
substitutes. Plain configuration
goes in `env`, which is set for everything the box starts and is meant to be readable.

`aglib/model/conformance`, `aglib/store/conformance` and `aglib/sandbox/conformance` are how a new
adapter finds out whether it means what the port says. Each is an inert list of named cases; a subject declares what it actually
enforces — its isolation, the postures it refuses, whether its output streams arrive apart, what it
does with a secret — and the suite holds it to exactly that. A provider claiming to substitute is
made to prove a process in the box cannot read the value.

## Failures

Expected outcomes are discriminated data with stable codes. Every unsupported capability says what
is missing. A developer never inspects error-message text to choose behaviour.

For the person using the application: committed content never disappears after a reconnect or a
restart, streaming text is visibly provisional until committed, and refusal, cancellation and
failure are understandable states rather than generic errors.

## For the agent

The agent is told only what the selected harness and environment actually support. Tool denial is
structured, not a sentence it must interpret. Context arrives through the explicit slots above.
Diagnostic, audit and secret-bearing detail stays in a tool result's `details`, which never reaches
model-visible content.

Permission decisions see validated arguments when each call reaches its execution slot, after the calls ordered before it finish. Cancellation while a decision is pending prevents execution. Applications still enforce consequential authority atomically at the resource boundary; a callback does not lock external state.

Tool results may carry `uncertain: true` when execution began but its effect is not known. A thrown tool and an interrupted call are uncertain, not evidence that nothing happened. The model reads that it must reconcile the original action before retrying, including under a new call ID; the executor never automatically repeats it. A definitive refusal remains an ordinary error. This records knowledge, not exactly-once execution of arbitrary tools.

Auxiliary model calls are `model.finished` entries with a purpose, generation identity and provider usage. They count toward run usage without becoming assistant messages or consuming a conversational turn. Compaction records its returned usage even when the resulting summary is rejected; providers that return no usage leave it unknown. Applications may record their own auxiliary calls using the same entry.
