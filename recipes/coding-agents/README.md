# coding-agents

Somebody else's whole agent, cheaply. Any agent in the ACP registry, started
inside your sandbox, inside your log, under your permission decision — for the
price of one line of argv.

```bash
bun run recipe coding-agents --agent claude-code "what is in this directory?"
bun run recipe coding-agents --agent codex --sandbox docker "run the tests"
```

## The thin end

`vendored-agents` is the other end of the same argument. It spends a vendor
dependency and a file per agent to keep the prompt, the tools and the resume.
This spends a line, and keeps three things:

- **The log.** Whatever the agent did arrives as our entries, so one durable
  session describes an ACP turn and a native turn identically.
- **The sandbox.** The agent *process* is started inside it, not merely served
  by it. A coding agent runs its own shell and delegates only the calls it
  chooses to, so moving the process is the only way to move all of it.
- **The decision.** `decide` runs on every call the agent makes.

And gives up three, which the adapter declares rather than simulating:

| | |
| --- | --- |
| Its tools are its own | They cannot be removed, only refused. `decide` sees a title and raw arguments, because the protocol carries no schema. |
| There is no system prompt | The protocol has no field for one, so orientation leads the first message and nowhere else. |
| `recovery: "none"` | The agent owns its context. Our entries describe what it did and cannot put it back mid-turn, so `runAgent` closes an interrupted session rather than handing it out for ever. |

## Every row is argv

That is the whole of `agents.ts`, and a row offering a prompt or a tool list
would be describing a control point this route does not have.

`credential` names environment rather than a credential type, because where an
agent's requests go is the operator's decision. Point `ANTHROPIC_BASE_URL` at
`serveAnthropicWire` from `vendored-agents` and the agent runs on whatever
`Model` is behind the port — this recipe neither knows nor needs to.

A row that cannot run here says why. That is a fact about this machine's setup
rather than about the agent, and leaving the row in with the reason attached is
more useful than deleting it, because the next person asks the same question.

## Which agents belong here rather than in `vendored-agents`

The test is whether the vendor ships its agent as a **library**. Claude Code and
Pi do, so they have deep adapters next door. OpenCode publishes one package and
no agent library — its loop is a composition of its own and its tools are
reachable only through its plugin boundary — so it belongs here. Codex ships
nothing embeddable either.

Claude Code appears in both, on purpose. It is the one agent where you can hold
the comparison still and change only the route.

## Holding a conversation

The agent owns its context, so continuing one means handing back the name it
knows it by. The adapter asks for `session/load` when given `resume`, and
reports the id through `onSession`; this recipe holds it for the life of the
process, which is as long as its in-memory store lasts. A deployment wanting
continuity across restarts would keep it in the session's metadata, which is
what metadata is for — aglib stores it and never reads it.

Orientation leads the *first* turn only. The protocol has no system-prompt
field, so it has nowhere else to go; repeating it every turn would be the same
words again to an agent that already has them.

## Running the live test

```bash
AGLIB_LIVE_ACP=1 \
  ANTHROPIC_BASE_URL=https://openrouter.ai/api \
  ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY \
  ANTHROPIC_API_KEY= \
  bun test recipes/coding-agents
```

That is the whole of pointing a protocol agent at a different provider: three
environment names the row declares, and OpenRouter serving the wire the agent
already speaks. Nothing translates anything.
