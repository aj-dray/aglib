/**
 * Lines that are instructions to the terminal rather than to the agent.
 *
 * `aglib/terminal` reads lines and knows nothing about commands, which is the
 * right split: what a `/` means is an application's vocabulary, and a second
 * application will want a different one. This is ours, and it is deliberately
 * three words long.
 */
import type { Sink } from "aglib/render";
import { providers, type Choice } from "./model.ts";

export interface CommandResult {
  /** Whether the line was a command, and so is not a turn for the agent. */
  handled: boolean;
  /**
   * What was asked for, when a model was named. Proposed rather than applied:
   * this cannot know whether the credential for that provider exists, so the
   * caller resolves it first and only then commits — otherwise a typo announces
   * a switch, mutates the selection, and leaves the session answering with
   * something it has already said it is not.
   */
  select?: { provider: Choice["provider"]; model: string };
}

const help = [
  "/model                     what is answering now",
  "/model <name>              switch model, keeping the provider",
  "/model <provider> <name>   switch both",
  "/detail answer|normal|debug   how much of a run to show",
  "/help                      this",
].join("\n");

export function runCommand(input: {
  line: string;
  choice: Choice;
  sink: Sink;
}): CommandResult {
  if (!input.line.startsWith("/")) return { handled: false };
  const say = (text: string) => (input.sink.status ?? input.sink.write)(`${text}\n`);
  const [name, ...rest] = input.line.slice(1).split(/\s+/);

  if (name === "help") { say(help); return { handled: true }; }

  if (name === "detail") {
    const level = rest[0];
    if (level !== "answer" && level !== "normal" && level !== "debug") {
      say(`Detail is ${input.sink.detail ?? "normal"}. One of: answer, normal, debug.`);
      return { handled: true };
    }
    // Mutated rather than rebuilt: the sink is the same screen throughout, and
    // handing the loop a new one would lose the cursor state it is holding.
    (input.sink as { detail?: Sink["detail"] }).detail = level;
    say(`Detail is now ${level}.`);
    return { handled: true };
  }

  if (name !== "model") { say(`No command '/${name}'. Try /help.`); return { handled: true }; }

  if (!rest.length) {
    say(`Answering with ${input.choice.provider} · ${input.choice.model}.`);
    return { handled: true };
  }

  // `/model <provider> <name>` when the first word names one, `/model <name>`
  // otherwise — so switching within a provider costs one word.
  const named = rest[0] as Choice["provider"];
  const namesProvider = providers.includes(named);
  // A lone provider name is a half-finished instruction, not a model called
  // `openrouter`. Saying so beats switching to something that does not exist.
  if (namesProvider && rest.length === 1) {
    say(`Name a model too — '/model ${named} <model>'.`);
    return { handled: true };
  }
  const provider = namesProvider ? named : input.choice.provider;
  const model = (namesProvider ? rest.slice(1) : rest).join(" ");
  if (!model) { say("Give a model name."); return { handled: true }; }

  return { handled: true, select: { provider, model } };
}
