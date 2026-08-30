# agent-service

A server you open in a browser to launch agents, watch them work, and message them. Each one gets
its own session, its own sandbox, and a harness you choose. They can start each other, list each
other, and interrupt each other.

```bash
bun run recipe agent-service          # http://127.0.0.1:3000
```

State goes to SQLite under `~/.agent-service` unless `DATABASE_URL` is set, in which case it goes to
Postgres. `SANDBOX=<name>` selects where an agent's hands are: `local` (the default — directories
under `SANDBOX_ROOT`, the host's authority, no isolation), `docker` (a container per session from the
local daemon, `DOCKER_IMAGE` deciding what is in it), or `daytona` (a container in someone else's
datacentre). One that is not built fails saying exactly which methods to implement.

Which one you pick decides whether an agent can read the key it is spending. A credential is handed
to the sandbox as a `Secret` naming the hosts it may go to, and the sandbox answers `secrets` with
what happened: `local` and `docker` say `"plain"` — the value is in the environment and anything in
there can read it — while `daytona` stores it with the vendor, gives the box `dtn_secret_<id>`, and
substitutes at egress, so the agent authenticates against its API and gets a 401 pointing that same
variable anywhere else. The SDK harness is the exception and says so: it runs Claude Code in this
process rather than in the box, so its credential is held here.

Run the workers in the process that serves the UI. Either store's change feed reaches its own
process and no further — Bun's `SQL` has no `LISTEN` channel, and a second driver is a dependency a
service shaped like this one does not need — so a worker started anywhere else is woken by nothing
and falls back on its heartbeat, thirty seconds against the half-second poll it would have used with
no feed at all.

Both adapters written here — the Postgres store and the Daytona sandbox — are checked against the
suites the library ships (`store.test.ts`, `sandbox.test.ts`). Set `DATABASE_URL` to run the first;
set `AGLIB_LIVE_SANDBOX=1` and connect Daytona to run the second, which creates and deletes real
boxes. Both skip by name otherwise.

## Agents, not integrations

The service defines a set of **agents** — native, Claude Code twice over (through its SDK and
through its protocol adapter), Codex, OpenCode, Cursor, Pi. What is uniform between them is fixed:

- one normalised entry log, so a Claude Code turn and a native turn read the same;
- four shared tools — `dispatch`, `delegate`, `sessions`, `send`;
- one decision function, which refuses every agent's private subagent tool;
- one sandbox; one orientation text.

What stays theirs is also fixed: their system prompt, their native tools, their context management
and compaction. We do not reimplement any of it.

## Replacing the private subagent

Every coding agent ships something like `Task`. A native subagent runs inside one session: it cannot
be listed, addressed or interrupted, and it vanishes with the turn that made it. So it is taken away
and two tools are offered instead.

| Tool | What it is |
| --- | --- |
| `dispatch` | Another agent, its own session, its own sandbox, its own harness and model. Returns immediately; it messages you when it finishes. |
| `delegate` | One bounded question answered in place. No session, no sandbox, no memory. |
| `sessions` | Every agent here — yours and everyone else's. |
| `send` | A message to any of them, landing at `interrupt`, `turn` or `next`. |

Where the harness allows it the native tool is **removed** from the model's context; where it does
not, it is **refused** when called. The capability table says which you get.

## The capability table

The three harness families are not equivalent, and the differences are not cosmetic. `GET
/api/agents` returns what each one actually gives you, so an operator chooses with the facts and no
option silently does nothing:

| Control | native | Claude Code (SDK) | protocol (ACP) |
| --- | --- | --- | --- |
| system prompt | full | full — ours alone, or appended to Claude Code's preset | **none** — the protocol has no such field |
| add tools | full | full, in-process | full, over a stdio bridge |
| remove native tools | full | full — removed from context | partial — refusable only |
| permission | full — with a validated schema | partial — real name and parsed input, no schema | partial — a title and raw arguments |
| context, compaction | full | none — the SDK owns its loop | none |
| model, effort, limits | full | full | partial / none |
| where its hands reach | full | full — its built-ins are taken away and sandbox-backed tools replace them | full — the process itself is started inside the sandbox |
| accounting | tokens, on the log | partial — input and cache, on the log; output is a placeholder the SDK only totals at the end | **none** — the protocol reports a spend figure and no token counts |

Two rows are worth reading twice. **Where an agent's hands reach is not where its process runs**,
and this table used to conflate them: the SDK harness runs inside the service, and it is still
contained, because when the sandbox is a real one its built-in tools are removed and sandbox-backed
ones put in their place. (On `SANDBOX=local` it keeps its own, which reach the same host the sandbox
does; asking for its own tools against a real sandbox is refused rather than run.) Only a harness
whose tools cannot be taken away has to be started inside the box, which is what the protocol
adapter does. And `system prompt: none` for ACP is a genuine protocol limit — orientation
goes into the first message and into the tool server's MCP instructions instead, never silently
dropped.

One difference the table does not carry, because it belongs to the port rather than to this service:
only the native harness can restart from committed history. `store.interrupted()` hands back a session
whose worker was killed mid-run whatever ran it, and for the other two `runAgent` ends that run
rather than continuing a conversation the agent can no longer see. The worker has opened a sandbox
by then, so such a session costs one machine — once, because the run is closed and never interrupted
again.

## Messaging

`send` names where the message should land, and the service answers with where it actually did:

- `interrupt` — that agent's current turn is ended so it reads this first. Whatever the turn had not
  committed is gone; everything it had is kept, including a tool call that was running, which is
  closed with its real outcome.
- `turn` — folded into the turn already running, after its next batch of tool results, which is the
  last point at which nothing is half-done. The agent reads it and keeps its work.
- `next` — at the start of that agent's next turn. The default.

Two ways a place is not reached, and both answer `next` rather than doing something harsher. A
harness with no safe point mid-turn cannot take a `turn` delivery, so it waits. And `interrupt` only
reaches an agent this process is running — elsewhere the message still lands, at `next`. The answer
says which, every time.

Who may message whom is a predicate in `send`, not a library concept. Today it is anyone; the
natural bound is the spawn tree, which a session's `key` already describes.

## What it proves about the library

| Concern | Where it lives |
| --- | --- |
| Atomic cross-session handoff | aglib — `store.append({ entries, enqueue })` |
| One activation per session | aglib — the claim taken by `store.next` |
| A harness per session, behind one port | aglib — `adapters/native`, `adapters/acp` |
| A sandbox per session | aglib — `sandbox`, with the agent started inside it |
| Live views | aglib — `store.read({ afterSeq })` |
| Finishing a session whose worker was killed | aglib — `store.interrupted()`, then `runAgent` with the claim it hands back |
| What a run consumed | aglib — `RunResult.spend`, summed from the `usage` each harness put on the log. This service passes no `price`, so it reports tokens and no money. |
| Postgres | **this recipe** — a `Store` written from nothing but the public interface |
| Daytona | **this recipe** — a `SandboxProvider` the same way, because it needs a vendor SDK |
| Claude Agent SDK harness | **this recipe** — a `Harness` written the same way, for the same reason |
| HTTP, UI, workers, who-may-message-whom | this recipe |

The bottom half is the interesting part: adapters built entirely from public contracts, by someone
outside the package. Copy any of them to start your own — and point `aglib/store/conformance` or
`aglib/sandbox/conformance` at it, because reading the interface is not the same as meaning it. Both
of these passed review and failed the suite.
