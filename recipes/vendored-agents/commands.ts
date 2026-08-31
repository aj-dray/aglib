/**
 * Lines meant for the terminal rather than the agent.
 *
 * The same three words `native-agents` knows, plus the one this recipe exists
 * to show: `/harness`, which continues the conversation with a different
 * vendor's loop. Whether that works is the whole argument of this directory,
 * so the command says which answer you are about to get rather than finding
 * out for you.
 */
import type { Sink } from "aglib/render";
import { harnessIds, type Choice, type HarnessId } from "./index.ts";

export interface CommandResult {
  handled: boolean;
  /** A model asked for, resolved by the caller before anything is committed to. */
  model?: { provider: Choice["provider"]; model: string };
  /** A harness asked for. */
  harness?: HarnessId;
}

const providers = ["openrouter", "openai", "anthropic"] as const;

const help = [
  "/model <name>              switch model, keeping the provider",
  "/model <provider> <name>   switch both",
  "/harness pi|claude-code    continue with a different loop",
  "/detail answer|normal|debug",
  "/help",
].join("\n");

export function runCommand(input: { line: string; choice: Choice; sink: Sink }): CommandResult {
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
    (input.sink as { detail?: Sink["detail"] }).detail = level;
    say(`Detail is now ${level}.`);
    return { handled: true };
  }

  if (name === "harness") {
    const wanted = rest[0] as HarnessId;
    if (!harnessIds.includes(wanted)) {
      say(`Answering with ${input.choice.harness}. One of: ${harnessIds.join(", ")}.`);
      return { handled: true };
    }
    if (wanted === input.choice.harness) { say(`Already ${wanted}.`); return { handled: true }; }
    // The distinction this whole recipe is about, said at the moment it bites.
    // Pi is assigned our committed log every activation, so it arrives knowing
    // what was said. Claude Code keeps its context in the agent, and a fresh
    // one has none of this conversation — `recovery: "none"` is that fact.
    say(wanted === "pi"
      ? "Pi reads the committed log, so it arrives knowing this conversation."
      : "Claude Code keeps its own context, and a new one has none of this conversation. It will start from your next message alone.");
    return { handled: true, harness: wanted };
  }

  if (name !== "model") { say(`No command '/${name}'. Try /help.`); return { handled: true }; }

  if (!rest.length) {
    say(`Answering with ${input.choice.harness} · ${input.choice.provider} · ${input.choice.model}.`);
    return { handled: true };
  }

  const named = rest[0] as Choice["provider"];
  const namesProvider = (providers as readonly string[]).includes(named);
  if (namesProvider && rest.length === 1) {
    say(`Name a model too — '/model ${named} <model>'.`);
    return { handled: true };
  }
  const provider = namesProvider ? named : input.choice.provider;
  const model = (namesProvider ? rest.slice(1) : rest).join(" ");
  if (!model) { say("Give a model name."); return { handled: true }; }
  return { handled: true, model: { provider, model } };
}
