# sdk-harness

Somebody else's agent, deeply integrated. Two vendor libraries wrapped as a
`Harness`, running inside our log, our sandbox and — through the wire bridge —
our model port.

```bash
bun run recipe sdk-harness --harness claude-code "summarise what is in this directory"
bun run recipe sdk-harness --harness pi --sandbox docker "check the disk usage"
```

## The claim

"Use their agent" and "own the session" are not a trade. What changes between
these two is *which control points you keep*, and both keep more than the
protocol route does.

| | `claude-code` | `pi` | ACP (`acp-switcher`) |
| --- | --- | --- | --- |
| Tools | its own, or ours through an in-process MCP server | ours, through the executor | **theirs** |
| `toolUse` | `harness` | `application` | `harness` |
| System prompt | its preset, with ours appended | ours | none — orientation leads the first message |
| Transcript | the agent's own | assigned from the log | the agent's own |
| `recovery` | `none` | `history` | `none` |
| Where it runs | this process | this process | inside the sandbox |

Pi is the deeper of the two, and that is a fact about its library rather than
about the vendor: `AgentState` exposes `systemPrompt`, `tools` and `messages` as
settable, so an activation can be seeded from the log and every call routed
through our executor. Claude Code's SDK gives more control over *its own*
prompt and tools, and keeps its context to itself.

Pi is also the row an earlier version of this repository listed as
`unavailable`. That was true of the protocol route and hid the fact that Pi
ships a library at all.

## One bridge, any model

Both libraries speak Anthropic's wire. `serveAnthropicWire` puts a socket in
front of `aglib/model/anthropic-wire` and hands each of them a base URL and a
token, so both run on whatever `Model` sits behind the port — OpenRouter here —
and neither learns which provider answered.

For Claude Code that is `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. For Pi
it is three fields on a model descriptor, because pi's model is a description
of a wire rather than a client.

The translation is in the package; only the listener is here. Serving HTTP is
deployment, and `docs/CODE.md` puts a vendor dependency in a recipe — the codec
has neither problem.

## Hands

`--hands own` leaves Claude Code's Read, Write, Edit and Bash in place. They run
in *this* process, so they reach this machine. Ask for that against a container
and the run fails rather than calling it contained.

`--hands sandbox` takes every built-in away — `tools: []` is default-deny, so a
tool added by a future version cannot quietly reach this machine — and gives
back `bash`, `read_file` and `write_file` through the sandbox port. The process
still runs here; its hands do not.

Pi has no built-ins to remove: its tools are whatever the executor lists.

## Running the live tests

Two gates, because `bun run check` is hermetic and a connected machine must not
spend money for running it:

```bash
AGLIB_LIVE_MODEL=1 bun test recipes/sdk-harness
```
