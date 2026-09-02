/**
 * Lines meant for the terminal rather than the agent.
 *
 * `/model` here is a request to the *agent*, not a choice we make: over the
 * protocol a model is one of the options the agent publishes, so the adapter
 * matches it against that agent's own selector and refuses by naming what it
 * does offer. That refusal is the honest one, and it arrives on the next turn.
 */
import type { Sink } from "aglib/render";
import { acpAgents } from "./agents.ts";
import type { Choice } from "./index.ts";

export interface CommandResult {
  handled: boolean;
  select?: Partial<Pick<Choice, "agent" | "model">>;
}

const help = [
  "/model <name>     ask the agent to use a model it publishes",
  "/agent <id>       start a different agent",
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

  if (name === "agent") {
    const wanted = rest[0];
    const row = acpAgents.find((agent) => agent.id === wanted);
    if (!row) {
      say(`Running ${input.choice.agent}. One of: ${acpAgents.map((agent) => agent.id).join(", ")}.`);
      return { handled: true };
    }
    if (row.unavailable) { say(`${row.title} is not available here: ${row.unavailable}`); return { handled: true }; }
    // A different agent is a different conversation: it owns its context, and a
    // new one has none of this. Said before it happens rather than discovered.
    say(`Starting ${row.title} on your next message. It will not have seen this conversation.`);
    return { handled: true, select: { agent: row.id } };
  }

  if (name !== "model") { say(`No command '/${name}'. Try /help.`); return { handled: true }; }
  if (!rest.length) {
    say(`Running ${input.choice.agent}${input.choice.model ? ` · ${input.choice.model}` : " · its own default"}.`);
    return { handled: true };
  }
  // Not validated here: only the agent knows what it publishes, and the adapter
  // already refuses an unknown one by listing what it offers.
  say(`Asking ${input.choice.agent} for '${rest.join(" ")}' on your next message.`);
  return { handled: true, select: { model: rest.join(" ") } };
}
