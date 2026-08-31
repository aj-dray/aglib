# vendored-agent

Build your own harness *from* somebody else's agent library rather than from
scratch — keeping their tools, adding yours, inside your log, your sandbox and
your executor.

```bash
bun run recipe vendored-agent --tools theirs "what is in this directory?"
bun run recipe vendored-agent --tools theirs --sandbox docker "tidy the imports in src/"
bun run recipe vendored-agent --tools ours --provider anthropic --model claude-sonnet-5 "read package.json"
```

**What this shows.** What a vendor's library has to expose for your log to remain the state — and
what composing one looks like when it does. Pi's coding agent is *composed*, not launched: its tools
are values you re-point at your sandbox, its transcript is a field you assign from the committed
log, and its model is a descriptor you aim at a provider. Three seams, three fields, no translation.

## Their tools are not all the same kind of thing

This is the finding the recipe exists for. "Reuse the vendor's tools" means
three different things depending on what the vendor ships, and only one of them
lets you keep your own guarantees.

| | **library** (Pi) | **process SDK** (Claude Code) | **protocol** (ACP, `coding-agent`) |
| --- | --- | --- | --- |
| Their tools are | **values** you can import | **names** you can enable | a **fact** you observe |
| Re-point them at a sandbox? | yes — each takes an `operations` seam | no, they run in the agent's process | no |
| Do their calls reach your executor? | yes | no | no |
| Add yours beside theirs? | yes — `state.tools` is one list you fill | as an MCP server, in their process | no |
| Seed the transcript from your log? | yes — `state.messages` | no | no |
| `recovery` | `history` | `none` | `none` |

**Pi is the deep one**, and that is a fact about its library rather than the
vendor. `createCodingTools(cwd, options)` returns objects, and each takes an
`operations` seam — `BashOperations.exec`, `ReadOperations.readFile`. So
`pi-tools.ts` reuses Pi's schema, description, truncation rules and prompt
guidance verbatim while the shell it runs and the files it reads are ours. The
model sees the tool exactly as Pi wrote it; we validate its arguments and
`decide` gates the call.

`state.tools` is one flat list we fill, so a tool this application owns — a
memory, a delegation, whatever it is actually for — goes in beside Pi's and is
gated identically. The axis is two values rather than three because *these*
three of ours are the same three jobs Pi already does, and better: there was a
`--tools both` that put both lists together, and against Pi it never ran a turn,
because our `bash` and Pi's `bash` are one name and `createExecutor` refuses a
duplicate. It only ever worked for a vendor whose tools arrived namespaced
inside its own process, which is the vendor that is no longer here.

## Why the Claude Code SDK is not here

It was, and removing it is the second finding. The SDK is a **process wrapper**,
not an agent library, so the middle column above is what you actually get:

- Its built-in tools can only be *named*. They live inside the agent process and
  reach this machine, so keeping them meant refusing every sandbox that was not
  this machine — a container it could not honestly be run in. It is also what
  `--tools both` was for: ours arrived namespaced as an MCP server, so the two
  sets could not collide. On a vendor that hands you its tools as values they
  share one namespace, and ours were duplicates of its own.
- Its context is its own. `state.messages` has no equivalent, so continuing a
  conversation meant handing back a session id and holding it somewhere, and
  `recovery: "none"` meant an interrupted run was simply over.
- It speaks Anthropic's wire and nothing else, so pointing it at a `Model` of
  ours took ~490 lines of local server impersonating Anthropic — for the one
  vendor that could not be told where to look. Pi is told in three fields.

That tier is real and worth knowing about, which is why the table keeps it. It
is documented here rather than carried in code because the code cost more than
the second data point returned: two model-wiring bugs traced to driving a vendor
through environment variables instead of composed values, and a translation
layer whose only customer it was. `coding-agent` still covers the
what-you-give-up end of the argument, over a protocol, for any agent at all —
including Claude Code, which has an ACP row there.

## What the harness no longer declares

An earlier version of the `Harness` port carried `toolUse: "application" |
"harness" | "none"`. This recipe is what removed it. Pi runs the *vendor's*
tools through our executor; a process-SDK harness runs tools *we wrote* inside
its own process. Whose tools, whose code and whose authority are three
questions, and one enum answered none of them reliably.

The question it reached for — did anyone authorize this call — is a property of
a call rather than a harness, and it varies within a run the moment an
application tool sits beside a vendor's. It belongs on the tool entry if
something ever needs to read it.

## Holding a conversation

**Pi is handed our log.** `transcriptFor` assigns `state.messages` from
`context.history()` on every activation, so the committed log is the only thing
that decides what it knows. That is `recovery: "history"`, and it means an
interrupted run can be picked up and finished — which `harness.test.ts` proves
by staging exactly what a killed worker leaves (a committed tool result, no
terminal entry) and having Pi finish it.

Nothing is held between turns, and that is the point. A harness whose context
lives in the vendor needs a session id threaded through every turn and a
decision about where it survives a restart. This one needs neither, because the
answer is already in the store.

It also means the log is genuinely the interchange: one session, two harnesses —
our own loop answers the first turn and Pi answers the second, having never seen
it happen. Nothing is translated and nothing is handed over, because there is
only one representation of a conversation here.

## Where its requests go

A pi-ai model is a *description* of an endpoint — an id, a wire and a base URL —
rather than a client, so `route.ts` is a table:

| provider | endpoint | wire |
| --- | --- | --- |
| `openrouter` | `openrouter.ai/api/v1` | OpenAI, which pi-ai already ships a descriptor for |
| `openai` | `api.openai.com/v1` | OpenAI |
| `anthropic` | `api.anthropic.com` | Anthropic |

That the file is short is the finding, not an omission. A vendor whose model is
a value needs nothing built for it.

## At the prompt

```
/options   whose tools, which model — and what each one costs
/detail minimal|standard|detailed
```

One command, and the same gesture `coding-agent` uses: `/options` prints what
can change, a number opens one, a number picks a value.

```
What this recipe lets you change:
   1. tools    theirs
   2. provider openrouter
   3. model    anthropic/claude-sonnet-5
   4. effort   default
Reply with a number to change one.
› 1
tools:
   1. ours
   2. theirs  ·  current
› 1
Ours: bash, read_file and write_file against the sandbox, validated here and
gated by `decide`.
```

The gesture is shared with `coding-agent`; the reason is not. There the axes
belong to the agent, which publishes them over the protocol, and naming them in
the recipe would be guessing at another product's vocabulary. Here they belong
to the recipe — a vendor library exposes a constructor rather than a menu — so
the table is ours, and it is `keyof Choice` so it cannot go stale silently.

`--sandbox` is the one axis argv sets and `/options` does not, because it has to
be answered before the sandbox is opened.

## Running the live tests

Gated, because `bun run check` is hermetic and a connected machine must not
spend money for running it:

```bash
AGLIB_LIVE_MODEL=1 bun test recipes/vendored-agent
```

They run Pi on the route Pi actually takes — straight to OpenRouter on the
OpenAI wire. They used to wrap a real model in the Anthropic-impersonating
server and hand Pi the socket, which meant no test ever exercised the route the
recipe gives it.
