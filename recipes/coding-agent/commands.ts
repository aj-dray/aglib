/**
 * Lines meant for the terminal rather than the agent.
 *
 * The agent's own choices, offered back. Over this protocol a model, a mode and
 * a reasoning level are not ours to invent: the agent publishes them on
 * `session/new`, the adapter reports them through `onConfig`, and this file
 * lists what came back and nothing else. Measured rather than assumed, because
 * two guesses about this were wrong before anyone ran it:
 *
 * | | model | mode | thought_level | other |
 * | --- | --- | --- | --- | --- |
 * | Claude Code | 5 | 6 | `effort`: default…max | `fast`, `agent` |
 * | Cursor | 35 | 3 | none — folded into the model id | — |
 *
 * A reasoning level is its own axis on Claude Code and part of the model id on
 * Cursor (`grok-4.6[effort=high]`). That difference is the agent's, and saying
 * it is better than flattening it.
 *
 * So there is one command and not one per axis. A command per category would
 * name another product's vocabulary, which is a guess, and the guess is stale
 * the first time an agent ships an option nobody here thought of — Claude
 * Code's `fast` and `agent` were already outside a table of three. `/options`
 * lists what this agent published, whatever that is, and a number drills into
 * one. Nothing to keep current.
 *
 * The command is `/harness` and not `/agent` because `vendored-agent` already
 * calls this exact question `/harness` — whose loop runs — and one fact does not
 * get two words across two recipes. What it picks is still an ACP *agent*,
 * which is the protocol's own word for the thing on the other end of the pipe.
 *
 * Picking is two lines rather than a nested prompt: a numbered list is
 * printed, and the next line chooses. A second readline over the same stdin
 * while the turn source owns it is a fight nobody needs for a menu.
 */
import type { Sink } from "aglib/render";
import type { AcpConfigOption } from "aglib/harness/adapters/acp";
import { acpAgents } from "./agents.ts";
import type { Choice } from "./index.ts";

/** A list that was printed, waiting for the next line to pick from it. */
export interface Choosing {
  /** The published option's own id, which is what `select` is keyed by. */
  option: string;
  label: string;
  choices: readonly { id: string; name: string }[];
  /** The agent's own category, or one of ours: "agent", "options". */
  category: string;
}

export interface CommandResult {
  handled: boolean;
  select?: Partial<Pick<Choice, "agent">>;
  /** One of the agent's published options, by its own id. */
  set?: { option: string; value: string };
  choosing?: Choosing | null;
}

const help = [
  "/options          what this agent lets you change — model, mode, effort, whatever it has",
  "/harness [id]     list the agents on offer, or start one",
  "/detail minimal|standard|detailed",
  "/help",
].join("\n");

const numbered = (rows: readonly { id: string; name: string }[], current: string | boolean): string =>
  rows.map((row, index) =>
    `  ${String(index + 1).padStart(2)}. ${row.name}${row.id === current ? "  ·  current" : ""}`).join("\n");

export function runCommand(input: {
  line: string;
  choice: Choice;
  sink: Sink;
  /** What the agent published on its last session. Empty before the first turn. */
  published?: readonly AcpConfigOption[];
  choosing?: Choosing | null;
}): CommandResult {
  const say = (text: string) => (input.sink.status ?? input.sink.write)(`${text}\n`);

  // A bare number answers whatever list was printed last. Checked before the
  // `/` test, because the answer to a menu is not a command.
  if (input.choosing && /^\d+$/.test(input.line.trim())) {
    const picked = input.choosing.choices[Number(input.line.trim()) - 1];
    if (!picked) {
      say(`No ${input.choosing.label} ${input.line.trim()}. 1 to ${input.choosing.choices.length}, or another command.`);
      return { handled: true };
    }
    // Drilling in rather than choosing: the first list was the options
    // themselves, so this picks which one to open and prints its values.
    if (input.choosing.category === "options") {
      const option = (input.published ?? []).find((candidate) => candidate.id === picked.id);
      if (!option?.choices?.length) {
        say(`${picked.name} is not a list on ${input.choice.agent}.`);
        return { handled: true, choosing: null };
      }
      say(`${option.name} on ${input.choice.agent}:`);
      say(numbered(option.choices, option.current));
      say("Reply with a number, or keep talking to leave it as it is.");
      return { handled: true, choosing: { option: option.id, category: option.category, label: option.name, choices: option.choices } };
    }

    say(`${input.choosing.label}: ${picked.name}, from your next message.`);
    // The warning belongs on both paths. Picking by number used to skip it,
    // which left the one consequence worth knowing on the branch nobody uses.
    if (input.choosing.category === "agent") {
      say("It will not have seen this conversation.");
    }
    return {
      handled: true,
      choosing: null,
      ...(input.choosing.category === "agent"
        ? { select: { agent: picked.id } }
        // Keyed by the option's own id and applied through the adapter's
        // `select`, so a category nothing here has heard of works the same way.
        : { set: { option: input.choosing.option, value: picked.id } }),
    };
  }

  if (!input.line.startsWith("/")) return { handled: false };
  const [name, ...rest] = input.line.slice(1).split(/\s+/);

  if (name === "help") { say(help); return { handled: true }; }

  if (name === "detail") {
    const level = rest[0];
    if (level !== "minimal" && level !== "standard" && level !== "detailed") {
      say(`Detail is ${input.sink.detail ?? "standard"}. One of: minimal, standard, detailed.`);
      return { handled: true };
    }
    (input.sink as { detail?: Sink["detail"] }).detail = level;
    say(`Detail is now ${level}.`);
    return { handled: true };
  }

  if (name === "harness") {
    const wanted = rest[0];
    if (!wanted) {
      const rows = acpAgents;
      say(`Agents, with ${input.choice.agent} running:`);
      say(numbered(rows.map((row) => ({ id: row.id, name: row.id })), input.choice.agent));
      return { handled: true, choosing: { option: "agent", category: "agent", label: "Agent", choices: rows.map((r) => ({ id: r.id, name: r.id })) } };
    }
    const row = acpAgents.find((agent) => agent.id === wanted);
    if (!row) { say(`No agent '${wanted}'. Try /harness.`); return { handled: true }; }
    // A different agent is a different conversation: it owns its context, and a
    // new one has not seen this. Said before it happens rather than discovered.
    say(`Starting ${row.id} on your next message. It will not have seen this conversation.`);
    return { handled: true, choosing: null, select: { agent: row.id } };
  }

  if (name === "options") {
    const published = input.published ?? [];
    if (!published.length) {
      say(`${input.choice.agent} publishes nothing to change.`);
      return { handled: true };
    }
    say(`What ${input.choice.agent} lets you change:`);
    for (const [index, option] of published.entries()) {
      const current = option.choices?.find((choice) => choice.id === option.current)?.name ?? String(option.current);
      say(`  ${String(index + 1).padStart(2)}. ${option.name.padEnd(12)} ${current}`);
    }
    say("Reply with a number to change one.");
    return {
      handled: true,
      choosing: {
        option: "options", category: "options", label: "Option",
        choices: published.map((option) => ({ id: option.id, name: option.name })),
      },
    };
  }

  say(`No command '/${name ?? ""}'. Try /help.`);
  return { handled: true };
}
