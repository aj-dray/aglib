# vendored-agents

Build your own harness *from* somebody else's agent library rather than from
scratch — keeping their tools, adding yours, inside your log, your sandbox and
your model port.

```bash
bun run recipe vendored-agents --harness pi --tools theirs "what is in this directory?"
bun run recipe vendored-agents --harness claude-code --tools both "tidy the imports in src/"
```

## Their tools are not all the same kind of thing

This is the finding the recipe exists for. "Reuse the vendor's tools" means
three different things depending on what the vendor ships, and only one of them
lets you keep your own guarantees.

| | Pi | Claude Code SDK | ACP (`coding-agents`) |
| --- | --- | --- | --- |
| Their tools are | **values** you can import | **names** you can enable | a **fact** you observe |
| Can you re-point them at a sandbox? | yes — every one takes an `operations` seam | no, they run in the agent's process | no |
| Do their calls reach your executor? | yes | no | no |
| Can you add yours beside theirs? | yes, same list | yes, as an MCP server | no |
| Seed the transcript from your log? | yes — `state.messages` | no | no |
| `recovery` | `history` | `none` | `none` |

**Pi is the deep one**, and that is a fact about its library rather than the
vendor. `createCodingTools(cwd, options)` returns objects, and each takes an
`operations` seam — `BashOperations.exec`, `ReadOperations.readFile`. So
`pi-tools.ts` reuses Pi's schema, description, truncation rules and prompt
guidance verbatim while the shell it runs and the files it reads are ours. The
model sees the tool exactly as Pi wrote it; we validate its arguments and
`decide` gates the call.

**Claude Code's built-ins can only be named.** They live inside the agent
process, so `--tools theirs` and `--tools both` keep tools that reach *this
machine* — which is why either one refuses a sandbox that is not this machine.
`--tools both` is the interesting mode: keep its editing tools, which are good,
and add yours beside them.

## Where their requests go

Both agents speak wires that real providers already serve, so they go straight
there. `route.ts` picks one of three:

| provider | Claude Code | Pi |
| --- | --- | --- |
| `anthropic` | its own API | the Anthropic wire |
| `openrouter` | **OpenRouter's Anthropic endpoint** — "Claude Code speaks its native protocol directly to OpenRouter. No local proxy server is required." | OpenRouter's OpenAI endpoint, which pi-ai already ships a descriptor for |
| anything else | the bridge | the bridge |

An earlier version sent *everything* through the bridge, so the two cases that
needed nothing paid for the one that did. Going direct restores prompt caching:
a second turn now reports something like `4 in · 9.5k cached`, where the bridge
had been stripping `cache_control` and re-sending the whole prefix at full price
every turn.

## The bridge, and what it costs

`serveAnthropicWire` puts a socket in front of `anthropic-wire.ts`, which turns
an Anthropic request into a `ModelRequest`, calls any `Model`, and turns the
answer back into Anthropic's frames. It is how a model speaking neither wire
drives Claude Code — the same job Ollama's Anthropic endpoint does for a local
model. `--bridge` forces it even where the provider would have served the wire
itself, which is how it stays exercised.

It is a recipe file and not package surface. The distinction is between a client
and an impersonation: `adapters/anthropic` sends on a wire Anthropic publishes;
this claims to *be* Anthropic to something that believes it. A partial
impersonation is a promise a library cannot keep, because keeping it means
tracking somebody else's protocol for ever.

What it still costs, stated rather than discovered:

- **Input tokens arrive late.** A `Model` reports what it spent when the
  generation *returns*; the wire wants that count before the first delta. The
  counts go out on `message_delta` instead, and a client reading usage only from
  `message_start` records none. Buffering the whole response would fix it and
  would end streaming.
- **No token counting.** `/v1/messages/count_tokens` is deliberately not served:
  counting for a model whose tokenizer we do not have is a guess feeding a
  client's compaction decisions. Absent, the client uses its own estimate.
- **Effort is bucketed.** A `thinking` budget maps to our three levels against
  the numbers the Claude Code harness itself sets, so a round trip returns what
  it asked for and anything else is approximate.

## What the harness no longer declares

An earlier version of the `Harness` port carried `toolUse: "application" |
"harness" | "none"`. This recipe is what removed it. Pi runs the *vendor's*
tools through our executor; Claude Code with `--tools ours` runs tools *we
wrote* inside its own process. Whose tools, whose code and whose authority are
three questions, and one enum answered none of them reliably. The comparison
above says it accurately, and prose is the right place for a fact about
adapters.

The question it reached for — did anyone authorize this call — is a property of
a call rather than a harness, and with `--tools both` it genuinely varies within
one run. It belongs on the tool entry if something ever needs to read it.

## Holding a conversation

The three harnesses continue a conversation two different ways, and the
difference is exactly what `recovery` declares.

**Pi is handed our log.** `transcriptFor` assigns `state.messages` from
`context.history()` every activation, so the committed log is the only thing
that decides what it knows. That is `recovery: "history"`, and it means an
interrupted run can be picked up and finished.

**Claude Code is handed its own name for the conversation.** Its context, its
prompt cache and its own compaction live in the agent, so continuing means
passing `resume` — the session id it reported when it started, held for the life
of this process and handed back on the next turn. That is `recovery: "none"`:
what matters is over there, so our entries describe what happened without being
able to put it back.

Where that id should live across a restart is a question this recipe does not
answer. Its store is in memory, so there is nothing to survive; a deployment
that wanted continuity across restarts would keep it in the session's metadata,
which is what metadata is for.

Feeding it our log instead would have worked and was the other real option: it
would make the log authoritative and survive the agent forgetting. It also
means paying to re-send the whole conversation to an agent that already has it,
every turn, and fighting the context management that is much of what buying
into an SDK is for.

## Running the live tests

Two gates, because `bun run check` is hermetic and a connected machine must not
spend money for running it:

```bash
AGLIB_LIVE_MODEL=1 bun test recipes/vendored-agents
```
