/**
 * Where a person's turns come from.
 *
 * The inbound half of a terminal, and the sibling of `channel.ts`: that one
 * turns a mail thread into deliveries on a session, this one turns typing into
 * the same thing. Neither is a library concern — which session a person is
 * talking to is an application's decision, and for a terminal the answer is
 * "the one" and delivery is a pipe that cannot fail.
 *
 * **Multi-turn is the default, and it is not a flag.** A conversation is what
 * this recipe is for, and one-shot is the special case — the one where nobody
 * is there. So the fact that decides it is whether stdin is a terminal, not
 * something an operator has to remember:
 *
 *   - A person at a terminal gets a prompt, and any task on argv is simply
 *     their first turn.
 *   - A pipe or a redirect gets one shot and an exit code, so
 *     `recipe native-agents "…" > answer.txt` and `echo … | recipe` both behave
 *     the way every other command-line program does.
 *
 * `--once` overrides the first case for someone who has a terminal and wants
 * the script behaviour anyway. There is no flag for the reverse, because
 * prompting into a pipe would hang waiting for a person who is not there.
 */
import { createInterface } from "node:readline";

export interface TurnSource {
  /** Whether a person is waiting, which decides prompting and how a failure ends. */
  interactive: boolean;
  lines: AsyncIterable<string>;
}

export function turnsFrom(input: {
  /** The task on argv, if there was one. */
  task: string;
  once: boolean;
  /** Injected so a test never touches a terminal. */
  stdin?: NodeJS.ReadStream;
  isTTY?: boolean;
}): TurnSource {
  const stdin = input.stdin ?? process.stdin;
  const interactive = (input.isTTY ?? stdin.isTTY === true) && !input.once;

  if (!interactive) {
    return {
      interactive: false,
      lines: (async function* () {
        // A task on argv wins; otherwise the whole of stdin is the task, which
        // is what a pipe means.
        if (input.task) { yield input.task; return; }
        const piped = await new Promise<string>((resolve) => {
          let read = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => { read += chunk; });
          stdin.on("end", () => resolve(read));
        });
        if (piped.trim()) yield piped.trim();
      })(),
    };
  }

  return {
    interactive: true,
    lines: (async function* () {
      if (input.task) yield input.task;
      const reader = createInterface({ input: stdin, output: process.stderr, prompt: "› " });
      reader.prompt();
      for await (const line of reader) {
        const said = line.trim();
        // A blank line is someone thinking, not an empty question.
        if (said) yield said;
        reader.prompt();
      }
      reader.close();
    })(),
  };
}
