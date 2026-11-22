# subscription-agent

Your own agent, paid for by a Claude or ChatGPT plan you already have. The
vendor's program runs the loop, and everything else is yours: the instructions,
the tools, where the tools run, and the log.

```bash
claude setup-token                                   # once, on a machine with a browser
CLAUDE_CODE_OAUTH_TOKEN=… bun run recipe subscription-agent --vendor claude --model claude-sonnet-5-5 "what is in this directory?"

bun run recipe subscription-agent --vendor codex --sign-in      # once: a device code to enter at OpenAI
bun run recipe subscription-agent --vendor codex --model gpt-6 "what is in this directory?"
```

**What this shows.** Where a plan can be spent, and what spending it costs an agent
of your own. Neither vendor sells model access with the subscription; they sell
their program, and the only door to the plan is that program. So the harness
*is* the program: `createClaudeAgentSdkHarness` starts the unmodified Claude Code
binary through Anthropic's Agent SDK, and `createCodexHarness` starts Codex's app
server, the protocol Codex's own clients speak.

## Whose terms these are

Read them yourself; they move. As of this writing:

- **Anthropic** says a Claude subscription's sign-in is "intended exclusively"
  for "ordinary use of Claude Code and other native Anthropic applications", that
  third-party developers may not route requests through plan credentials "on
  behalf of their users", and that this "does not prevent an end user from
  signing in to the unmodified Claude Code binary with their own Claude
  subscription" ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  This recipe is that last sentence: one person, their own plan, the unmodified
  binary. Anything with a second user is the case it forbids. `ANTHROPIC_API_KEY`
  works the same way and has none of this question.
- **OpenAI** offers *Sign in with ChatGPT* for third-party tools, with partner
  terms for apps that run on a server. Codex itself signs in with your plan, and
  that is what this uses: Codex's own device-code flow, its own token store, its
  own refresh.

## What is ours, and what is theirs

| | |
| --- | --- |
| Instructions | **ours**, as the whole system prompt (Claude Code) or the thread's base instructions (Codex) |
| Tools | **ours only**. Claude Code's built-ins are switched off (`tools: []`) and ours are served in-process over MCP; Codex's are disabled by feature name and ours are declared as dynamic tools Codex calls back for. A Codex item that is not one of our calls fails the turn, so a built-in that a later Codex adds cannot run quietly |
| Where tools run | **ours** — the executor, the sandbox, `decide`, the log |
| The vendor process's environment | **built, not inherited**: its credential and its state directory, nothing else the host holds |
| Context | **theirs**. Compaction is theirs too |
| Continuing a conversation | the vendor's session, named on the log's last assistant entry. If another model has spoken since, or the vendor has lost the session, a new one opens with the conversation so far as a transcript |
| An interrupted turn | over — `recovery: "none"` |
| Spend | token counts on the final entry; the cost Claude Code computes from API list prices is not recorded, because a plan was not charged it |
| Input to a running turn | folded in after a tool result, as in our loop: a queued message (Claude Code) or `turn/steer` (Codex) |

The log stays the interchange in one direction: every call is committed the way
our own loop commits one, so a native model can take over the session and read it
as its own. The other direction is the transcript, because neither vendor accepts a
conversation it did not have.

## Where its state lives

`AGLIB_SUBSCRIPTION_HOME` (default `~/.aglib-subscription-agent`): `claude/` is
`CLAUDE_CONFIG_DIR`, `codex/` is `CODEX_HOME` — the sign-in and the sessions a
later run resumes — and `log.db` is the session log. Losing `claude/` or `codex/`
costs the vendor's copy of a conversation, not the conversation.

## Running the binary tests

The adapters' tests drive a scripted vendor. Two more drive the real binaries
against a local stand-in for the model API — no network, no credential — and are
opt-in because the binaries are large:

```bash
CLAUDE_CODE_EXECUTABLE=$(node -p 'require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude")') \
CODEX_EXECUTABLE=$(which codex) bun test src/harness/adapters
```
