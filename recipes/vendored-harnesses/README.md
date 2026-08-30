# vendored-harnesses

Build your own harness *from* somebody else's agent library rather than from
scratch — keeping their tools, adding yours, inside your log, your sandbox and
your model port.

```bash
bun run recipe vendored-harnesses --harness pi --tools theirs "what is in this directory?"
bun run recipe vendored-harnesses --harness claude-code --tools both "tidy the imports in src/"
```

## Their tools are not all the same kind of thing

This is the finding the recipe exists for. "Reuse the vendor's tools" means
three different things depending on what the vendor ships, and only one of them
lets you keep your own guarantees.

| | Pi | Claude Code SDK | ACP (`acp-switcher`) |
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

## One bridge, any model

Both libraries speak Anthropic's wire. `serveAnthropicWire` puts a socket in
front of `aglib/model/anthropic-wire` and hands each a base URL and a token, so
both run on whatever `Model` is behind the port, and neither learns which
provider answered.

For Claude Code that is `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. For Pi
it is three fields on a model descriptor, because Pi's model *is* a description
of a wire rather than a client.

The translation is in the package; only the listener is here. Serving HTTP is
deployment, and `docs/CODE.md` puts a vendor dependency in a recipe — the codec
has neither problem.

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

## Running the live tests

Two gates, because `bun run check` is hermetic and a connected machine must not
spend money for running it:

```bash
AGLIB_LIVE_MODEL=1 bun test recipes/vendored-harnesses
```
