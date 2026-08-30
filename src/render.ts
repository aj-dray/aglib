/**
 * A run, as lines someone can read.
 *
 * A root file rather than a module, and a projection rather than a port: this
 * is `textOf` one level out. `toMessages` folds committed entries into what a
 * model is shown; this folds the update stream into what a person is shown. No
 * adapter has to prove anything about it, so there is nothing here for a
 * conformance suite to hold, and nothing below it to rank against.
 *
 * **It is not a channel, and the difference is worth stating because it is
 * subtle.** A channel does three jobs: decide which session a person is talking
 * to, deliver a message exactly once, and put the result in a medium's own
 * shape. The first two are an application's — a mail thread maps to a session,
 * a webhook may arrive twice. Only the third is the same work for every medium,
 * and only the third is here. Email is a channel with no projection at all: it
 * sends `RunResult.output` and never looks at the stream. A terminal is the
 * other extreme — its identity is "the one session" and its delivery is a pipe
 * that cannot fail, so a terminal channel is *nothing but* this projection.
 *
 * **The answer and the stream are different things, and only one is a message.**
 * `RunResult.output` is what `finished` hands to `Delivery.input`: the same
 * `Content`, whether the recipient is a person or another session. The stream
 * is not a message and never becomes one — a `cancelled` or `failed` result has
 * no `output` field at all, so a run can stream a paragraph and produce nothing
 * that could be delivered.
 *
 * Showing that paragraph is not a mistake. Watching what an agent was saying
 * when it was cancelled is most of what debugging one is. What would be a
 * mistake is leaving the outcome implicit, so the text reads as an answer that
 * was never given — which is why `finish` always states it, and takes it from
 * the result rather than from whatever happened to stream.
 *
 * **`detail` is the knob that makes one projection serve every medium.** Email
 * wants `"answer"`: the message, nothing else, because it has nowhere to put
 * anything else. A terminal wants `"normal"`. Someone working out why a run
 * did what it did wants `"debug"`, and the difference between those two is
 * verbosity rather than a different renderer.
 *
 * Two channels out, because they answer different questions. `write` carries
 * the answer, so redirecting it captures the answer and nothing else. `status`
 * carries what the agent did on the way — tools, provenance, what it spent.
 */
import type { AgentRun, RunResult } from "./agent.js";
import type { Update } from "./harness/harness.js";
import type { Content, ContentPart } from "./content.js";
import type { Stored, ToolCall, Usage } from "./session/entry.js";
import { textOf } from "./content.js";

export interface Sink {
  /** The answer: assistant text, exactly as it streamed. */
  write(text: string): void;
  /** Everything else. Defaults to `write`; a terminal usually points it at stderr. */
  status?(line: string): void;
  /** Enables colour and the elapsed-time ticker. A caller without a terminal leaves it off. */
  tty?: boolean;
  /**
   * How much of the run to show.
   *
   * `"answer"` writes the assistant's text and nothing else — the shape a
   * medium with no second channel needs. `"normal"` adds what the agent did:
   * tool calls and their results, where a message came from, what the run
   * spent. `"debug"` adds what it was thinking, arguments as they form, and
   * the structured `details` a tool returned.
   */
  detail?: "answer" | "normal" | "debug";
  /**
   * Marks a run being watched rather than driven — a subagent taken off the
   * queue, most often. A labelled run has no answer channel: nobody asked it
   * anything, so everything it says is an account of what the run it belongs
   * to is doing, and all of it is prefixed and sent to `status`.
   */
  label?: string;
  /** Milliseconds, for durations. Supplied by a test so its output is exact. */
  now?(): number;
}

/**
 * Not exported, and that is the gate's doing rather than an oversight.
 *
 * `renderRun` is the whole of what a caller needs, and nothing here composes a
 * renderer by hand. A surface that pushes updates itself — an HTTP stream, a
 * Slack message it keeps editing — would want this, and it can be exported the
 * day one exists. Surface without a consumer is surface nobody is holding to
 * account.
 */
interface Renderer {
  update(update: Update): void;
  /** The outcome and what it spent. */
  finish(result: RunResult): void;
}

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** One line, however long the thing being described is. */
const oneLine = (text: string, limit = 96): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

const round = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Content as the model sees it, plus a marker for every part it cannot.
 *
 * `textOf` drops images, files and opaque blocks, which is right for a model
 * and wrong for a person: a screen showing less than the log holds, silently,
 * is the omission this package refuses everywhere else.
 */
function readable(content: Content): string {
  if (typeof content === "string") return content;
  return content.map((part: ContentPart) =>
    part.type === "text" ? part.text
      : part.type === "image" ? `[image ${part.mediaType}]`
      : part.type === "file" ? `[file ${part.name ?? part.mediaType}]`
      : `[opaque ${part.provider}]`).join("\n");
}

function createRenderer(sink: Sink): Renderer {
  const status = sink.status ?? sink.write;
  const detail = sink.detail ?? "normal";
  const debugging = detail === "debug";
  const now = sink.now ?? (() => Date.now());
  const label = sink.label ? `${sink.label} ` : "";
  const started = now();

  const dim = (text: string) => (sink.tty ? `${DIM}${text}${RESET}` : text);
  const mark = (glyph: string, bad: boolean) =>
    sink.tty ? `${bad ? RED : GREEN}${glyph}${RESET}` : glyph;

  /** Names by call id. A tool entry carries only the id; the assistant entry above holds the name. */
  const names = new Map<string, string>();
  /** When each call started, so a result can say how long it took. */
  const clocks = new Map<string, number>();
  /**
   * Characters written since the last assistant entry.
   *
   * The harnesses disagree about deltas — our loop and Pi stream tokens, the
   * Claude Code SDK emits one delta per whole message, and a harness may emit
   * none. The entry stream is the one channel every harness fills, so an
   * assistant entry prints its text only when nothing streamed it first. Every
   * harness renders; none renders twice.
   */
  let streamed = 0;
  let turns = 0;
  /** Whether the last thing written ended mid-line, so a status line can open a fresh one. */
  let open = false;
  let thinking = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const line = (text: string) => {
    // `"answer"` has nowhere to put a status line, so it does not make one.
    if (detail === "answer") return;
    if (open) { sink.write("\n"); open = false; }
    status(`${label}${text}\n`);
  };

  const stopTicker = () => {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = undefined;
    if (sink.tty) status("\r\x1b[K");
  };

  /** Partial line held back while a labelled run streams, so the prefix stays whole. */
  let held = "";

  const say = (text: string) => {
    stopTicker();
    if (thinking) { thinking = false; }
    streamed += text.length;
    if (!sink.label) {
      sink.write(text);
      open = !text.endsWith("\n");
      return;
    }
    // A prefix cannot be applied to half a line, so a labelled run buffers to
    // the newline. Nothing is lost: `finish` flushes whatever is left.
    held += text;
    let cut = held.indexOf("\n");
    while (cut !== -1) {
      line(held.slice(0, cut));
      held = held.slice(cut + 1);
      cut = held.indexOf("\n");
    }
  };

  const entry = (stored: Stored) => {
    if (stored.type === "run.started") {
      // Input with no `from` is what the caller just passed in. Echoing it says
      // everything twice. Input *with* one came from somewhere else — a
      // subagent's report, a peer, a person on a channel — and saying so is the
      // only way that arrival is visible as itself.
      if (stored.from) {
        line(dim(`◦ from ${stored.from.kind} ${stored.from.id.slice(0, 8)} · ${oneLine(readable(stored.input), 72)}`));
      }
      return;
    }
    if (stored.type === "assistant") {
      turns += 1;
      const said = readable(stored.content);
      if (said && streamed === 0) say(said.endsWith("\n") ? said : `${said}\n`);
      streamed = 0;
      for (const call of stored.calls ?? []) {
        names.set(call.callId, call.name);
        line(dim(`→ ${call.name} ${oneLine(call.arguments, 72)}`));
      }
      return;
    }
    if (stored.type === "tool.started") {
      clocks.set(stored.callId, now());
      if (!sink.tty) return;
      // The one piece of cursor control in this file, and the only reason a
      // long command is not silence. Unref'd so it can never hold a process open.
      const at = now();
      const name = names.get(stored.callId) ?? stored.callId.slice(0, 8);
      ticker = setInterval(() => { status(`\r${DIM}${label}  ${name} ${seconds(now() - at)}${RESET}\x1b[K`); }, 1000);
      ticker.unref?.();
      return;
    }
    if (stored.type === "tool.finished") {
      stopTicker();
      const at = clocks.get(stored.callId);
      clocks.delete(stored.callId);
      const name = names.get(stored.callId) ?? stored.callId.slice(0, 8);
      const took = at === undefined ? "" : ` · ${seconds(now() - at)}`;
      const body = oneLine(readable(stored.result.content), 64);
      line(`${mark(stored.result.isError ? "✗" : "✓", stored.result.isError === true)} ${dim(`${name}${took}${body ? ` · ${body}` : ""}`)}`);
      // `details` is the structured channel for an application's own UI and
      // holds whatever that application put there — which may include a
      // credential. Asked for explicitly it is shown; it is never volunteered.
      if (debugging && stored.result.details !== undefined) {
        line(dim(`  ${oneLine(JSON.stringify(stored.result.details), 96)}`));
      }
      return;
    }
    if (stored.type === "summary") {
      line(dim(`· compacted through seq ${stored.replaces}`));
    }
    // `run.finished` is not rendered here. `finish` owns the last line, because
    // `RunResult` carries what the entry cannot: what the run spent, on every
    // outcome including the ones with no answer.
  };

  return {
    update(next) {
      if (next.type === "text.delta") { say(next.text); return; }
      if (next.type === "reasoning.delta") {
        // Reasoning can outweigh the answer several times over, so it is behind
        // `"debug"` rather than dimmed and always present.
        if (!debugging) return;
        if (!thinking) { line(dim("· thinking")); thinking = true; }
        stopTicker();
        status(dim(next.text));
        return;
      }
      if (next.type === "tool.progress") {
        const name = names.get(next.callId) ?? next.callId.slice(0, 8);
        line(dim(`⋯ ${name} ${oneLine(JSON.stringify(next.data), 64)}`));
        return;
      }
      // Arguments as they form are unparseable until complete and only one
      // harness emits them, so they are worth nothing to a reader and
      // everything to someone asking why a call came out the way it did.
      if (next.type === "tool-call.delta") {
        if (debugging) line(dim(`  ${next.callId.slice(0, 8)} ${oneLine(next.arguments, 64)}`));
        return;
      }
      if (next.type === "entry") entry(next.entry);
    },

    finish(result) {
      stopTicker();
      if (held) { line(held); held = ""; }
      if (open) { sink.write("\n"); open = false; }

      const spent = [
        result.usage.inputTokens !== undefined ? `${round(result.usage.inputTokens)} in` : undefined,
        result.usage.cacheReadTokens ? `${round(result.usage.cacheReadTokens)} cached` : undefined,
        result.usage.outputTokens !== undefined ? `${round(result.usage.outputTokens)} out` : undefined,
      ].filter((part): part is string => part !== undefined);

      // A count nobody reported is not a zero, so an absent one is left out
      // rather than printed as 0.
      const parts = [
        seconds(now() - started),
        `${turns} ${turns === 1 ? "turn" : "turns"}`,
        ...spent,
      ].join(" · ");

      if (result.status === "failed") {
        line(`${mark("✗", true)} ${dim(`failed (${result.error.code}): ${oneLine(result.error.message, 80)} · ${parts}`)}`);
        return;
      }
      line(dim(`— ${result.status} · ${parts}`));
    },
  };
}

/**
 * Render a run to its end, and answer what it did.
 *
 * The loop every application writes by hand, with the two things a hand-written
 * one keeps getting wrong: everything the stream carries besides text, and an
 * outcome taken from the result rather than from whatever happened to stream.
 */
export async function renderRun(run: AgentRun, sink: Sink): Promise<RunResult> {
  const renderer = createRenderer(sink);
  for await (const update of run) renderer.update(update);
  const result = await run.result;
  renderer.finish(result);
  return result;
}

/** Re-exported so a caller composing a sink imports one thing. */
export type { Update, RunResult, Usage, ToolCall };
