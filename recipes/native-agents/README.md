# native-agents

One operator, one machine, one `~/.agent`. The smallest thing that is still a
real assistant: our own loop, one hand, a memory it edits, skills it loads,
subagents it hands work to, and a choice of where commands run.

```bash
bun run recipe native-agents                     # a conversation
bun run recipe native-agents "what did I decide about pricing?"
bun run recipe native-agents --sandbox docker --detail debug "check the disk usage"
echo "how many sessions do I have?" | bun run recipe native-agents > answer.txt
```

## Multi-turn is the default, and it is not a flag

A conversation is what this recipe is for; one shot is the special case — the
one where nobody is there. So the fact that decides it is whether stdin is a
terminal, which is the same rule every other command-line program follows:

- **A person at a terminal** gets a prompt, and a task on argv is simply their
  first turn. Every turn runs against the same session, which is what makes it
  a conversation rather than a series of strangers — and the only way the
  120,000-token compaction budget below is ever reached.
- **A pipe or a redirect** gets one shot and an exit code, so this composes with
  everything else on the command line.

`--once` overrides the first case for someone who has a terminal and wants the
script behaviour anyway. There is no flag for the reverse, because prompting
into a pipe would wait for a person who is not there.

## At the prompt

A line beginning with `/` is for the terminal, not the agent — it never reaches
the log.

```
/model                        what is answering now
/model <name>                 switch model, keeping the provider
/model <provider> <name>      switch both
/detail answer|normal|debug   how much of a run to show
/help
```

A model is a value here rather than a name the library resolves, so switching
one builds a different `Model`, a different harness and a different agent — from
the next turn, and the subagent too. The prompt cache is scoped to the model
that filled it, so the turn after a switch pays full price for the instructions
and context again. `/model` says so rather than leaving it to an invoice.

`--detail answer | normal | debug` decides how much of the run you see. The
answer always goes to stdout and everything else to stderr, so redirecting
captures the answer alone. `debug` adds reasoning, arguments as they form, and
the structured `details` a tool returned — including a cancelled run's partial
text, which is most of what debugging one is.

## What it demonstrates

| Concern | Where it lives |
| --- | --- |
| Conversation history, resume | aglib — the session log |
| Keeping a long conversation in budget | aglib — compaction in the native harness |
| Subagents, and their answers coming back | aglib — `enqueue`, `next`, and the `finished` hook |
| Containment, or an explicit refusal to pretend | aglib — `isolation: "required"` against two providers |
| Memory, skills, channels | this recipe — a markdown file, a directory, and one function |

## `~/.agent`

```text
~/.agent/
  agent.db          the log — aglib owns sessions and entries
  memory.md         entries the agent writes, separated by `---`
  skills/<name>/SKILL.md
  instructions.md   optional; a default is used when absent
```

**State on the host, execution in the box.** This is the split Hermes takes and
the one worth copying. `~/.agent` lives where the process lives; the sandbox is
disposable and may be a container on the other side of a socket. Memory kept
inside the box would be lost every time the box was replaced, which is the
normal case rather than the edge one.

Skills stay on the host too, and `load_skill` reads them here. A skill whose
procedure is "run this script" writes the script into the sandbox with `bash`
when it gets there. Hermes bind-mounts its skills directory read-only into the
container instead; aglib's sandbox port has no mount, and copying on demand is
honest about that rather than pretending the directory is present.

## One hand

`bash`, and nothing else that a shell already does. `read_file`, `write_file`,
`glob` and `grep` would each be a second name for a command the model already
knows. A dedicated tool earns its place when it has no shell equivalent —
`memory` and `load_skill` do, `cat` does not.

## Memory

`memory.md`, edited through one tool with `add`, `replace` and `remove`, capped
at 2,000 characters. Three details are taken from Hermes because it has already
paid for them:

- **A tool rather than the shell**, so the budget is enforced and the write is
  validated. The agent could write this file with `bash`; it does not.
- **No read action.** The entries are already in the run context.
- **A full memory answers with its contents**, so the model consolidates in the
  same turn instead of having an entry silently evicted.

Writes are durable immediately and visible from the *next* conversation. The
entries sit in the cached prefix, and rewriting that mid-run would invalidate
the cache on every turn after it.

## Subagents

`spawn` hands a child a goal and the context its parent chose to give it — never
the parent's transcript, which would carry the parent's confusions and be paid
for on every turn.

The mechanism is one write. `enqueue` commits the delivery in the same
compare-and-swap that commits the turn asking for it, so a spawn is never
half-done. That is also why `spawn` returns immediately rather than awaiting an
answer: the delivery does not exist until the turn carrying it commits, so a
tool that waited here would wait for itself. The child's `finished` hook
delivers its output back at `priority: "turn"`, and the same worker that ran the
child picks the parent up again.

## Channels

`channel.ts` is the whole of "put this agent on email": map a thread to a
session, a sender to `key`, and append a delivery. A worker that was already
draining the queue answers it.

```ts
await receive({ store, agent, message: { thread, sender, body } });
```

IMAP, webhooks and an SMTP credential are deployment, and are deliberately not
here — a recipe that needed a mailbox could not be run.
