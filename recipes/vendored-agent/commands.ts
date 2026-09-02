/**
 * Lines meant for the terminal rather than the agent.
 *
 * One command, and the same two-line gesture `coding-agent` uses: `/options`
 * prints what can change, a number opens one, a number picks a value. The
 * gesture is shared deliberately — moving between the two recipes should not
 * mean learning a second way to ask the same question.
 *
 * The *reason* is not shared, and the difference is worth keeping straight.
 * Over ACP the axes belong to the agent: it publishes them on `session/new`,
 * and naming them in the recipe would be guessing at another product's
 * vocabulary. Here they belong to this recipe. A vendor library exposes a
 * constructor rather than a menu, so nothing is published and this table *is*
 * the menu — which is why `AxisId` is `keyof Choice`: rename a field there and
 * this list fails to compile rather than going quietly stale.
 *
 * `tools` is the axis the recipe exists for and the reason this is a menu
 * rather than a flag: two lines, and it says what the choice costs before it
 * happens rather than after.
 */
import type { Sink } from "aglib/render";
import type { Choice } from "./index.ts";

/** What an operator may change mid-conversation. `keyof Choice`, so it cannot drift. */
export type AxisId = Extract<keyof Choice, "tools" | "provider" | "model" | "effort">;

interface Axis {
  id: AxisId;
  /** Empty means the axis takes a name: there is no list to print, so the next line is the value. */
  choices: readonly string[];
  /** What this value costs, for the selection it would land in. */
  note?: (value: string, choice: Choice) => string;
}

const axes: readonly Axis[] = [
  {
    id: "tools",
    choices: ["ours", "theirs"],
    // The finding, said at the point where it is being chosen. Pi's tools are
    // values that take an `operations` seam, which is why "theirs" here does
    // not mean what it means for a vendor that ships names.
    note: (value) => value === "ours"
      ? "Ours: bash, read_file and write_file against the sandbox, validated here and gated by `decide`."
      : "Pi's own tools as values, re-pointed at your sandbox — its schema, truncation and prompt guidance, your shell, your executor. Same list, same gate.",
  },
  {
    id: "provider",
    choices: ["openrouter", "openai", "anthropic"],
    note: () => "Three fields on a descriptor, and no translation. The credential has to be in the environment already.",
  },
  {
    id: "model",
    choices: [],
    note: () => "A cold prompt cache. This id is what the provider is asked for, so it has to be one that provider answers to.",
  },
  {
    id: "effort",
    choices: ["low", "medium", "high"],
    note: () => "Passed to Pi as its thinking level.",
  },
];

/** A list that was printed, waiting for the next line to answer it. */
export interface Choosing {
  /** null while the list is the axes themselves, so a number opens one rather than picking a value. */
  axis: AxisId | null;
  label: string;
  /** Empty when the axis takes a name: the next line is the value, whatever it says. */
  choices: readonly string[];
}

export interface CommandResult {
  handled: boolean;
  /** An axis and a value, resolved by the caller before anything is committed to. */
  set?: { axis: AxisId; value: string };
  choosing?: Choosing | null;
}

/**
 * One axis moved, as a whole selection.
 *
 * Exported because `index.ts` applies the same move, and resolving a provider's
 * credential can fail — so the caller needs the selection it *would* land in
 * before it commits to it.
 */
export const patched = (choice: Choice, axis: AxisId, value: string): Choice =>
  ({ ...choice, [axis]: value }) as Choice;

const shown = (axis: Axis, choice: Choice): string => String(choice[axis.id] ?? "default");

const numbered = (rows: readonly string[], current: string): string =>
  rows.map((row, index) =>
    `  ${String(index + 1).padStart(2)}. ${row}${row === current ? "  ·  current" : ""}`).join("\n");

const help = [
  "/options   whose tools, which model — and what each one costs",
  "/detail minimal|standard|detailed",
  "/help",
].join("\n");

export function runCommand(input: { line: string; choice: Choice; sink: Sink; choosing?: Choosing | null }): CommandResult {
  const say = (text: string) => (input.sink.status ?? input.sink.write)(`${text}\n`);
  const line = input.line.trim();
  const choosing = input.choosing;

  /** The consequence first, then the move. `index.ts` says what the selection became. */
  const commit = (axis: Axis, value: string): CommandResult => {
    const note = axis.note?.(value, input.choice);
    if (note) say(note);
    return { handled: true, choosing: null, set: { axis: axis.id, value } };
  };

  const open = (axis: Axis): CommandResult => {
    if (!axis.choices.length) {
      say(`${axis.id} is ${shown(axis, input.choice)}. Name a new one on the next line, or /options to go back.`);
      return { handled: true, choosing: { axis: axis.id, label: axis.id, choices: [] } };
    }
    say(`${axis.id}:`);
    say(numbered(axis.choices, shown(axis, input.choice)));
    say("Reply with a number, or keep talking to leave it as it is.");
    return { handled: true, choosing: { axis: axis.id, label: axis.id, choices: axis.choices } };
  };

  // A bare number answers whatever list was printed last. Checked before the
  // `/` test, because the answer to a menu is not a command.
  if (choosing?.choices.length && /^\d+$/.test(line)) {
    const picked = choosing.choices[Number(line) - 1];
    if (!picked) {
      say(`No ${choosing.label} ${line}. 1 to ${choosing.choices.length}, or another command.`);
      return { handled: true };
    }
    // The first list was the axes themselves, so a number opens one.
    const axis = axes.find((candidate) => candidate.id === (choosing.axis ?? picked));
    if (!axis) return { handled: true, choosing: null };
    return choosing.axis === null ? open(axis) : commit(axis, picked);
  }

  if (line.startsWith("/")) {
    const [name, ...rest] = line.slice(1).split(/\s+/);

    if (name === "help") { say(help); return { handled: true, choosing: null }; }

    if (name === "detail") {
      const level = rest[0];
      if (level !== "minimal" && level !== "standard" && level !== "detailed") {
        say(`Detail is ${input.sink.detail ?? "standard"}. One of: minimal, standard, detailed.`);
        return { handled: true, choosing: null };
      }
      (input.sink as { detail?: Sink["detail"] }).detail = level;
      say(`Detail is now ${level}.`);
      return { handled: true, choosing: null };
    }

    if (name === "options") {
      say("What this recipe lets you change:");
      for (const [index, axis] of axes.entries()) {
        say(`  ${String(index + 1).padStart(2)}. ${axis.id.padEnd(8)} ${shown(axis, input.choice)}`);
      }
      say("Reply with a number to change one.");
      return {
        handled: true,
        choosing: { axis: null, label: "option", choices: axes.map((axis) => axis.id) },
      };
    }

    say(`No command '/${name ?? ""}'. Try /help.`);
    return { handled: true, choosing: null };
  }

  // An axis that takes a name is answered by the next line, whatever it says —
  // which is why the `/` test is above this one and not below it.
  if (choosing && !choosing.choices.length && line) {
    const axis = axes.find((candidate) => candidate.id === choosing.axis);
    if (axis) return commit(axis, line);
  }

  return { handled: false };
}
