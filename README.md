# aglib

A small TypeScript toolkit for building **your own agent harness**, inside an application you own.

You bring the product — users, tenancy, channels, UI, deployment, policy. aglib gives you a
session log you can resume, a loop that runs against it, tools under your own permission rule,
somewhere contained to run them, and four seams with adapters: model, store, sandbox, harness.

> **Pre-release.** The API changes without deprecation aliases. Both recipes run.

## The shape

```text
src/
  json.ts  result.ts  content.ts  agent.ts  run.ts

  session/    entry.ts  log.ts  messages.ts        the log — this IS the session's state
  tools/      tool.ts  execute.ts                  declaring and running tools

  model/      model.ts    adapters/{openai-compatible,anthropic,fake}/  conformance.ts
  store/      store.ts    adapters/sqlite.ts        conformance.ts
  sandbox/    sandbox.ts  adapters/{local,docker}   conformance.ts
  harness/    harness.ts  adapters/{native,acp}/
```

Four ports, each `<port>.ts` → `adapters/`. Read one and you can predict the rest. Our own loop is
`adapters/native`, beside the others rather than above them: it is one implementation of the port,
and the only thing special about it is that it holds every control point.

**The log is the state, not a record of it.** The loop re-projects its context from committed
entries every turn and appends results back. There is one representation of a conversation, so
nothing can drift from it and no test has to prove two views agree.

**One session hands work to another in a single write.** `append({ entries, enqueue })` commits what
this session did and what another receives, together or not at all — so spawning a child, replying
to a parent and messaging a peer are one operation, and a handoff cannot be half-done. A delivery
names where in the recipient's loop it lands: `interrupt` ends the running turn, `turn` is folded into it before its next model call, `next` waits for the one after.

**A killed worker's session is finishable.** `store.next()` answers what has been asked for;
`store.interrupted()` answers what was being worked when a process stopped existing. Either hands back a
claim, and a claim is what a run takes:

```ts
runAgent({ agent, store, sessionId, input: "..." });   // a caller sends
runAgent({ agent, store, claim });                     // a worker runs what it was handed
```

The claim carries the session, the position and the queue together, so a worker lines nothing up by
hand. A claim with an empty queue is a resumption: the log is continued rather than begun again, and
the tool call that already ran is read from it, never issued twice. A harness that cannot restart
from history ends that run instead of continuing it, so a session nothing can finish is closed once
rather than handed out for ever.

**A model is a value, not a name.** A `Model` is a provider, a credential and a model id together;
picking a different one is picking a different `Model`, and routing between them is a record lookup
you write. Nothing here resolves a name, so nothing here owns a naming convention — names come *out*
(`ModelResponse.model`, and what `price` reads) and never go in.

**You are told when to look, and you still keep a heartbeat.** `store.watch()` is an optional
interrupt line — which session moved, whether it has work owed, nothing else. A wake may be spurious
or lost by design, so it removes latency rather than the need to ask; without one, a worker polls and
that interval is the whole of a message's latency.

**Where a port has more than one implementation, it has one executable contract.**
`aglib/model/conformance`, `aglib/store/conformance` and `aglib/sandbox/conformance` are the cases an
adapter must pass, as an inert list you run under your own test framework. Point one at a model, a
store or a sandbox you wrote and find out whether it means what the interface says. A subject
declares what it actually does — whether its output streams arrive apart, how far its change feed
reaches — and the suite holds it to exactly that rather than assuming.

## Quickstart

```bash
bun install --frozen-lockfile
echo 'OPENROUTER_API_KEY=sk-or-...' > .env
bun run recipe personal-agent "what did I decide about pricing?"
```

```ts
import { runAgent, defineTool, textOf } from "aglib";
import { createNativeHarness } from "aglib/harness";
import { createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { Database } from "bun:sqlite";
import { z } from "zod";

const bookkeeper = {
  id: "bookkeeper", version: "1",
  instructions: "Answer from the ledger.",
  harness: createNativeHarness({
    model: createOpenRouterModel({ apiKey: process.env.OPENROUTER_API_KEY!, model: "deepseek/deepseek-v4-flash" }),
  }),
  tools: [defineTool({
    name: "read_ledger",
    description: "Read the September ledger.",
    annotations: { readOnly: true },
    schema: z.object({}),
    execute: () => ({ content: "September closes at 1250 GBP." }),
  })],
};

const run = runAgent({
  agent: bookkeeper,
  store: createSqliteStore({ database: new Database("agent.db") }),
  input: "What is the September balance?",
});

for await (const update of run) if (update.type === "text.delta") process.stdout.write(update.text);
const result = await run.result;
if (result.status === "completed") console.log(textOf(result.output));
```

Drop `store` and the same agent runs entirely in memory. Durability is a composition choice,
not a different program.

A run answers with `usage` on every outcome — completed, cancelled or failed — summed from the entries it committed, so a harness reports no total of its own and a run that burned tokens and then failed says so.

There is no price list here and no spend ceiling. The counts are the fact; the rates are yours, and so is what to do when a run gets expensive.

## Recipes

Two applications, chosen because between them they exercise every seam. They are the
specification: anything with no call site in one of them should not exist.

| Recipe | What it proves |
| --- | --- |
| [`recipes/personal-agent`](recipes/personal-agent/README.md) | The log, compaction, context lifetimes, tools, session search. Memory built entirely *on* the library, not in it. |
| [`recipes/agent-service`](recipes/agent-service/README.md) | The queue, atomic cross-session handoff, a harness per session, a sandbox per session, live views. |

## What it is not

Not a workflow engine, channel gateway, scheduler, memory product, prompt registry, deployment
control plane, or finished agent. It does not make model output trustworthy, and a local
sandbox is a host process, not a sandbox — ask for `isolation: "required"` and a provider that
cannot deliver it fails rather than pretending. `adapters/docker` is the one that can: a container
from the local daemon, no account and no vendor SDK. A hosted box is yours to adapt, and
`agent-service` shows one.

It also ships no price list. Rates go stale between releases and only one provider ever reported a
cost, so the log carries token counts and the money is arithmetic over a table you pass in.

## Four ways in

aglib is for building the **outer** harness — the durable session, the tools, the policy, the
orchestration — around whatever does the reasoning inside.

| You want | You do |
| --- | --- |
| A loop you own end to end | Use `adapters/native` |
| Your own reasoning strategy | Write a `Harness` and drop it in |
| A vendor SDK, deeply integrated | Wrap it as a `Harness` — you keep its prompt, tools and settings, and choose which to override |
| Somebody else's whole agent, cheaply | Use `adapters/acp` — any agent in the ACP registry, still inside your log, tools and sandbox |

The last two are not equivalent, and `recipes/agent-service` publishes a table of exactly which
control points each one gives you.

## Development

```bash
bun run check     # typecheck, tests, build, Node verification, recipes, docs, invariants
bun run recipe personal-agent "..."
```

`bun run check` is the green gate. A failing check is a decision, not an obstacle: fix the code,
or change the check deliberately in the same commit with the reason in the message.

See [`AGENTS.md`](AGENTS.md) for the map, and [`docs/`](docs/) for the four documents that own
the product.

## License

MIT. See [`LICENSE`](LICENSE).
