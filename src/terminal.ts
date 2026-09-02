/**
 * Where a person's turns come from.
 *
 * The inbound half of the one channel this package ships, and `render` is the
 * outbound half. A channel does three things — decide which session a person is
 * talking to, deliver a message exactly once, and put the result in a medium's
 * own shape. For a terminal the first is "the one session" and the second is a
 * pipe that cannot fail, so the two halves collapse to a keyboard and a screen,
 * and both are the same for every application. A mail bridge keeps all three
 * and is yours; this is the degenerate case, which is why it can be here.
 *
 * It is the one file in `src` that touches `process`, and it is confined to
 * that: `render` takes a sink, this takes a stream, and neither reaches for a
 * terminal it was not handed.
 *
 * **Multi-turn is the default, and it is not a flag.** A conversation is what
 * this recipe is for, and one-shot is the special case — the one where nobody
 * is there. So the fact that decides it is whether stdin is a terminal, not
 * something an operator has to remember:
 *
 *   - A person at a terminal gets a prompt, and any task on argv is simply
 *     their first turn.
 *   - A pipe or a redirect gets one shot and an exit code, so
 *     `recipe native-agent "…" > answer.txt` and `echo … | recipe` both behave
 *     the way every other command-line program does.
 *
 * There is no flag either way. `--once` existed to give a person at a terminal
 * the script behaviour, and `echo "…" | recipe` already does that — a second
 * way to say a thing the shell says better. Prompting into a pipe has no flag
 * for the opposite reason: it would wait for a person who is not there.
 */
import { createInterface } from "node:readline";
import type { Sink } from "./render.js";

export interface TurnSource {
  /** Whether a person is waiting, which decides prompting and how a failure ends. */
  interactive: boolean;
  lines: AsyncIterable<string>;
}

export function turnsFrom(input: {
  /** The task on argv, if there was one. */
  task: string;
  /** Injected so a test never touches a terminal. */
  stdin?: NodeJS.ReadStream;
  isTTY?: boolean;
}): TurnSource {
  const stdin = input.stdin ?? process.stdin;
  const interactive = input.isTTY ?? stdin.isTTY === true;

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

/**
 * The standard pair of channels for a terminal.
 *
 * The answer on stdout, the account of the run on stderr, so redirecting the
 * first captures the answer and nothing else. Written out identically in three
 * recipes before this existed, which is two more copies than a fact deserves.
 */
export function terminalSink(options: { detail?: Sink["detail"] } = {}): Sink {
  return {
    write: (text) => process.stdout.write(text),
    status: (line) => process.stderr.write(line),
    tty: process.stderr.isTTY === true,
    ...(options.detail ? { detail: options.detail } : {}),
  };
}
