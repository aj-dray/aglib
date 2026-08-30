# PRODUCT — what aglib is, for whom, and why

> **aglib is what you build your own harness on. It gives you the session, the log, and the seams;
> you bring the product.**

## Definition

A small TypeScript toolkit for building an application-owned agent harness, or for putting a
stable application boundary around someone else's.

It lets a developer define an agent without choosing a framework, run it through a native loop or
a conforming harness adapter, give it tools under an explicit permission rule, run those tools in a
real container or on the host, keep one canonical session log, pick up an activation whose process
died and finish it from committed state, report what every activation consumed, hand work to another session
atomically with a stated urgency, and project the same events into any UI or channel.

The simplest useful program is an agent, a model, and `runAgent`. Durability is added by supplying
a store. The agent definition does not change.

## Who owns what

- The **application** owns users, tenancy, channels, UI, business data, long-term knowledge,
  process placement, deployment, policy, and who may message whom.
- **aglib** owns the session log, tool identity and execution, the delivery envelope, the four port
  contracts, and the suites an adapter proves itself against.
- The **harness** owns how one activation reasons and acts: its prompt, its context strategy, its
  built-in tools.

## The inclusion test

> Does it change **what is recorded**, **who may act now**, or **what an adapter must prove**?
> If not, it belongs in the application.

And a second, sharper one: **does one of the two recipes call it?** If not, it does not exist.

The third clause is not decoration. A port with several implementations is a promise about all of
them, and the only way to keep it is an executable one — so `store` and `sandbox` each ship the
cases an adapter must pass. That is also the boundary for money: rates fail the first clause outright
(they change nothing that is recorded and go stale between releases), while the arithmetic over them
passes it, because a ceiling that stops a run changes who may act now.

## Principles

1. **The log is the state.** Not a record of state kept somewhere else. There is one representation
   of a conversation, so nothing can drift from it.
2. **Small defaults.** One obvious path first; options appear when two real consumers disagree.
3. **One name per fact.** Session, run, entry, tool call, delivery, store, model, sandbox and
   harness each name one thing. A field is named for the requirement it states, not for the
   mechanism that happens to satisfy it today — which is why a delivery has a `priority` and not an
   `interrupt` flag.
4. **Declare what you do.** A capability you lack fails typed. Isolation is requested and either
   enforced or refused. Counts a provider did not report stay absent rather than becoming zero.
5. **Permission precedes effect.** Parsed arguments are decided on before a tool runs.
6. **Composition over machinery.** A function is the escape hatch — no registry, middleware
   language, workflow DSL, or plugin system.

## Non-goals

Not a hosted control plane, worker-orchestration product, channel gateway, UI kit, workflow engine,
prompt registry, evaluation platform, memory abstraction, or message bus. Messaging between
sessions is one field on one store operation, not a subsystem: who may address whom, and what to do
about a cycle, are application policy.

Memory is five different things and only one is ours: working memory, which is the log plus
compaction. Learned facts, skills, session search and retrieval are application code reaching the
library through two seams — tools, and run-scoped context. Both recipes demonstrate this, which is
why there is no `memory/` module and should not be one.

## Not guaranteed

**Exactly-once external side effects.** A call whose result never committed is closed in the
projection with a statement that it did not report back. Nothing is re-executed automatically,
because a library cannot know whether an effect was idempotent.

**Reading a delivery mid-turn, in every harness.** Our own loop does it between batches of tool
results, which is the last point at which nothing is half-done — so a `turn` delivery reaches a busy
session and the session keeps its work. A harness that owns its own loop has no such point to offer,
and there a `turn` delivery waits for the next activation instead. It is never promoted to ending the
one that is running: a sender asking for the place that costs nothing does not get the one that costs
a turn. The table in `recipes/vendored-agents` says which harness offers which.

**Durable partial text on cancellation.** Streamed deltas are provisional. Committed entries are
not.

**Money this package had to work out, and any ceiling on it.** A run reports what every generation
consumed — the counts, and the cost where the provider stated one, which a router does on every
response. It derives nothing and stops there. Published rates move faster than a release, so a table here would go stale with nothing
failing to say so — and a ceiling over them would have to read a function the caller supplies and
then defend against it, which is a lot of machinery for a decision that is the deployment's anyway.
The three ceilings that do exist are over facts this package already holds: turns, tool calls, and
the clock.

**That an interrupted activation is picked up.** The store can say which sessions were being worked
when a process stopped existing, and a run can continue one from its committed log. Deciding to ask
is the application's, because finishing that work is a choice and not every application wants it.
And only a harness that can restart from committed history continues one at all: where the agent's
own context died with the process, the interrupted run is ended and recorded as failed, which is the
honest outcome for work nothing can resume.

**`interrupt` reaching a session running in another process.** The message lands, but at `next`:
only the process holding an activation can end it. The answer to a send says which happened.

**Deduplication of a delivery for ever.** An `id` means "this delivery, once", and it has to outlive
the queue, because the common case is a duplicate arriving after the first copy was read — so a store
remembers it for a window an application sets and can reason about. It is not a permanent record of
everything a session has ever received.

## What makes it credible

Not a feature matrix — proofs that fail loudly when they stop being true: both recipes run against
the built package; the personal agent's whole memory system is built on the library without
extending it; a stale write is refused with the real position rather than silently winning; a call
that permission refuses finishes the run instead of parking it; and every exported value is composed
by a recipe or deleted.

The strongest of them is that the ports have more than one implementation and one executable
contract between them. Two stores and three sandboxes answer the same cases. Pointing those cases at
the adapters that had been read into existence from the interface alone — a Postgres store and a
hosted sandbox, both written outside this package — failed both of them, on things no type could
have caught: a
claim renewed when a run started rather than on every write it made, a failed delivery that
committed the sender's entries anyway, a staleness window as wide as the clock skew between two
machines, paths never confined to their root, a close that reported a refusal to release, and one
combined output stream reported as two. Both now pass, and neither can quietly stop.
