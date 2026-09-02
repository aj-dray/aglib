# coding-agent

Somebody else's whole agent, cheaply. Any agent in the ACP registry, started
inside your sandbox, inside your log, and through your permission seam — for the
price of one line of argv. The shipped rule allows everything, deliberately: a
recipe does not know an operator's policy. `decide` in `index.ts` is where one
goes, and what it can see over this protocol is named there.

```bash
bun run recipe coding-agent                       # pick an agent, then talk to it
bun run recipe coding-agent --harness cursor "what is in this directory?"
bun run recipe coding-agent --harness claude-code --sandbox docker "run the tests"
```

**What this shows.** The cheapest containment on offer: a vendor's whole agent process started
*inside* your sandbox, its work arriving as your entries, for one row of argv. What you give up —
its tools, its prompt, its recovery — is named below rather than papered over.

At the prompt, `/harness` changes which agent runs and `/options` lists what
*that* agent lets you change — its own options, its own values, never a menu
this recipe invented. A number drills into one, a second number picks a value.

One command rather than `/model`, `/mode`, `/effort`, because naming the axes
means guessing at another product's vocabulary, and the guess was already
wrong — these are the two we measured:

| | publishes |
| --- | --- |
| Claude Code | `mode` (6) · `model` (5) · `effort` default…max · `fast` on/off · `agent` |
| Cursor | `model` (35) · `mode` (3) — a reasoning level is inside the model id, `grok-4.6[effort=high]` |

## The thin end

`vendored-agent` is the other end of the same argument. It spends a vendor
dependency to compose one library's agent — its tools re-pointed at a sandbox,
its transcript assigned from the log. This spends a line, and keeps three
things:

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
anything serving that wire — a provider, a gateway, or a local server of your
own — and the agent runs on it. This recipe neither knows nor needs to.

A row that cannot run here says why. That is a fact about this machine's setup
rather than about the agent, and leaving the row in with the reason attached is
more useful than deleting it, because the next person asks the same question.

## Which agents belong here rather than in `vendored-agent`

The test is whether the vendor ships its agent as a **library** — tools as
values, a transcript you can assign. Pi does, so it has a deep adapter next
door. Nothing else measured here does. OpenCode publishes one package and no
agent library: its loop is a composition of its own and its tools are reachable
only through its plugin boundary. Codex ships nothing embeddable either. The
Claude Code SDK is the near miss — it *is* a library, but of a process, so its
tools are names and its context is its own; `vendored-agent`'s README says what
that cost when it lived there, and its row is here instead.

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

## At the prompt

```
/options          what this agent lets you change — model, mode, effort, whatever it has
/harness [id]     list the agents on offer, or start one
/detail minimal|standard|detailed
/help
```

`/options` prints what *this* agent published, a number opens one, a second
number picks a value. Nothing here names an axis, which is the point: a model
is one of the agent's own options rather than a choice this recipe makes, and
the adapter applies the pick keyed by the agent's own id. An agent that has
published nothing is told so plainly rather than shown an empty menu.

`/harness` starts a different agent, which is a different conversation: it owns
its context, and a new one has not seen this. The command says so before it
happens, and what the old agent published is not what the new one offers, so
the menu is asked for again.

The same two-line gesture drives `vendored-agent`, on purpose. The reason
differs — there the axes are the recipe's own, because a vendor library
publishes a constructor rather than a menu — but an operator moving between the
two should not have to learn a second way to ask the same question.

## Running the live test

```bash
AGLIB_LIVE_ACP=1 \
  ANTHROPIC_BASE_URL=https://openrouter.ai/api \
  ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY \
  ANTHROPIC_API_KEY= \
  bun test recipes/coding-agent
```

That is the whole of pointing a protocol agent at a different provider: three
environment names the row declares, and OpenRouter serving the wire the agent
already speaks. Nothing translates anything.
