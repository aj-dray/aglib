# INTERFACE — the outward-facing surface, and what shapes it

Everything an application touches: the SDK, and the shapes a CLI, HTTP API or UI is built from.

## The SDK

The first useful agent fits on one screen — [`recipes/native-agents`](../recipes/native-agents/README.md)
is a real one. Imports perform no I/O. Defaults open no connection, database, process or sandbox.
Every stateful dependency is passed in.

Construction uses a small grammar: `defineX` creates an inert validated declaration, `createX`
creates a stateful composition, `runX` performs immediate work.

Adding durability changes the composition around the agent, not the agent. The same definition that
ran under `runAgent` runs with a store, and what it gains is a durable log and resume.

## The two context slots

An application places context by lifetime, and the loop puts it on the right side of the cache
boundary:

- **`context.run`** sits inside the cached prefix and is fixed for the run — remembered facts, a
  skill index, a tenant profile.
- **`context.turn`** sits after it and is for one request — retrieved documents, the clock.

This is the seam every memory system reaches the library through, and it is deliberately the only
one besides tools. Getting the split right is the loop's job because only the loop knows where the
prefix ends; a fact written mid-run therefore applies from the next run, because rewriting a cached
prefix invalidates every following turn.

## What a run consumed

A run answers with `usage` on every outcome, because a run that burned a thousand tokens and then failed burned them. It is summed from the `assistant` entries the activation committed, so a harness reports no total of its own and a cancelled run still says what it cost.

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
activation is committed as `run.finished` with a `no-recovery` failure, and `agent.finished` fires,
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
says what actually served, `entry.generation.model` records it, and `price` reads it. `effort` stays
on the request, because how hard to think is a knob over one call rather than part of which model
this is.

## Waiting for work

`store.watch(watcher)` is an optional interrupt line: it says a session moved and whether it now has
work owed, and the only correct response is to ask the store what it says now. A caller keeps a
heartbeat regardless — nothing about a wake is guaranteed except that the change is readable by the
time it arrives — so the feed buys latency, not certainty. A store with no push channel omits the
method and its callers poll, which is the difference between a message reaching a busy service in
milliseconds and in half a second.

## Events, and every other surface

A run is an `AsyncIterable` of ephemeral updates with a `result` promise. Committed entries carry a
sequence number; deltas do not and are never recovery state.

That single pair — **entries with a cursor, deltas without** — is what every outward surface is
built from. A CLI prints deltas. An HTTP API streams entries after `?after=N`. A web UI resumes
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

Input carries `from` onto the recipient's `run.started` — `{ kind, id }`, naming what sort of sender it was and which one. aglib mints exactly one kind, `"session"`; a person, a channel, a schedule and a webhook are the application's words, because only the application can close that list. The projection names it in the turn itself, so a recipient can tell a person typing from a peer agent from a routine firing, and can see that it has already answered one that arrived twice.

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

`aglib/sandbox/conformance` and `aglib/store/conformance` are how a new adapter finds out whether it
means what the port says. Each is an inert list of named cases; a subject declares what it actually
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
