/**
 * `~/.agent` — everything the agent is, on the machine the agent runs on.
 *
 * The split this recipe takes from Hermes, and the one decision worth copying:
 * **state on the host, execution in the box.** Memory, skills and the log live
 * here beside the process; the sandbox is disposable and may be a container on
 * the other side of a socket. Putting memory in the box would mean losing it
 * every time the box is replaced, which is the normal case, not the edge one.
 *
 * Read at call time rather than at module load, so a test can point the whole
 * layout at a temporary directory and never touch the operator's real agent.
 */
import { mkdir } from "node:fs/promises";

export interface Home {
  root: string;
  database: string;
  memory: string;
  skills: string;
  instructions: string;
}

export async function openHome(): Promise<Home> {
  const root = process.env["AGENT_HOME"] ?? `${process.env["HOME"]}/.agent`;
  const home: Home = {
    root,
    database: `${root}/agent.db`,
    memory: `${root}/memory.md`,
    skills: `${root}/skills`,
    instructions: `${root}/instructions.md`,
  };
  await mkdir(home.skills, { recursive: true });
  return home;
}

export const defaultInstructions =
  "You are a personal assistant on the operator's own machine. Be brief. "
  + "You have one hand — `bash` — and everything else is a command you compose with it. "
  + "Consult the skill index before improvising a procedure, and record durable facts with `memory`.";
