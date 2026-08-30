/**
 * The service's HTTP surface, as this interface consumes it.
 *
 * Types here mirror `src/session/entry.ts` and the routes in `server.ts`. They
 * are declared rather than imported because this app is built by Vite from its
 * own package and never joins the library's build.
 */

/* ------------------------------------------------------------------ content */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string }
  | { type: "file"; mediaType: string; name?: string }
  | { type: "opaque"; provider: string };

/** Content is parts or a plain string; some parts have no text at all. */
export type Content = string | readonly ContentPart[];

/**
 * The readable text of some content.
 *
 * A part that is not text is named rather than dropped: a transcript that
 * silently loses a screenshot is a transcript that lies about what was said.
 */
export function textOf(content: Content): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return `[image ${part.mediaType}]`;
      if (part.type === "file") return `[file ${part.name ?? part.mediaType}]`;
      return `[${part.provider} block]`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ entries */

export interface ToolCall {
  callId: string;
  name: string;
  /** Unparsed JSON, as the provider sent it. */
  arguments: string;
}

export interface ToolResult {
  content: Content;
  details?: unknown;
  isError?: boolean;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Failure {
  code: string;
  message: string;
  retryable?: boolean;
}

export type Entry =
  | { type: "run.started"; runId: string; input: Content; from?: string }
  | {
      type: "assistant";
      runId: string;
      content: Content;
      calls?: readonly ToolCall[];
      usage?: Usage;
      /** Which model answered, and the span the call took. Absent unless a model produced the turn. */
      generation?: { model?: string; startedAt: string; endedAt: string };
    }
  | { type: "tool.started"; runId: string; callId: string }
  | { type: "tool.finished"; runId: string; callId: string; result: ToolResult }
  | { type: "summary"; runId: string; content: string; replaces: number }
  | { type: "run.finished"; runId: string; outcome: "completed" | "failed" | "cancelled"; error?: Failure };

export type Stored = Entry & { seq: number; at: string };

/* -------------------------------------------------------------------- shape */

export interface HarnessModel {
  id: string;
  title: string;
}

export interface Harness {
  id: string;
  title: string;
  summary: string;
  connected: boolean;
  /** Why it cannot be chosen. Only when `connected` is false. */
  why?: string;
  models: readonly HarnessModel[];
  /** Whether a reasoning budget can be set at all. */
  effort: boolean;
}

export interface SessionSummary {
  sessionId: string;
  parentSessionId: string | null;
  title?: string;
  harness?: string;
  model?: string;
  effort?: string;
  running: boolean;
  updatedAt: string;
}

/**
 * Something the agent behind this session lets us change, in its own words.
 *
 * A harness row can only name models for an agent whose models we know; the
 * rest publish their own, along with whatever else they let a client set — a
 * reasoning level, a mode, a toggle. The ids and the labels are the agent's,
 * recorded rather than translated, because mapping six of its levels onto three
 * of ours would be guessing at another product's vocabulary.
 */
export interface AgentOption {
  id: string;
  name: string;
  /** "model", "thought_level", "mode", "model_config", or whatever the agent says. */
  category: string;
  description?: string;
  current: string | boolean;
  /** Absent for a boolean option. */
  choices?: readonly { id: string; name: string }[];
}

export interface SessionMetadata {
  title?: string;
  harness?: string;
  provider?: string;
  model?: string;
  effort?: string;
  preset?: string;
  sandboxId?: string;
  /** Read from the agent when the session opened. Empty until it has run once. */
  options?: readonly AgentOption[];
  /** What has been chosen among `options`, by the agent's own ids. */
  select?: Readonly<Record<string, string | boolean>>;
}

export interface SessionDetail {
  sessionId: string;
  seq: number;
  metadata: SessionMetadata;
  running: boolean;
  entries: readonly Stored[];
}

export interface Credential {
  id: string;
  title: string;
  help: string;
  kind: "infrastructure" | "agent";
  via: "key" | "token" | "login";
  connected: boolean;
  /** The command to run, for connections the operator completes in a terminal. */
  command?: string;
}

/**
 * Where a message lands in the recipient's loop. The store's own three words —
 * a second set here would be a second name for one fact, and the operator would
 * be the one guessing which mapped to which.
 */
export type Priority = "interrupt" | "turn" | "next";

/* ------------------------------------------------------------------- client */

class HttpError extends Error {}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new HttpError(body?.error ?? `${response.status} ${response.statusText}`);
  if (body && typeof body === "object" && "error" in body && body.error) throw new HttpError(body.error);
  if (body === null) throw new HttpError("the service answered with something that is not JSON");
  return body;
}

const send = (path: string, method: string, body: unknown): Promise<{ ok: true }> =>
  json<{ ok: true }>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Every harness, already configured, with whether it can be started. */
export const harnesses = (): Promise<readonly Harness[]> => json<readonly Harness[]>("/api/harnesses");

export const sessions = (): Promise<readonly SessionSummary[]> =>
  json<readonly SessionSummary[]>("/api/sessions");

export const session = (sessionId: string): Promise<SessionDetail> =>
  json<SessionDetail>(`/api/sessions/${sessionId}`);

export const startSession = (harness: string, task: string): Promise<{ sessionId: string }> =>
  json<{ sessionId: string }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness, task }),
  });

export const tuneSession = (
  sessionId: string,
  tuning: {
    model?: string;
    effort?: string;
    /** By the agent's own option ids, merged into what the session already holds. */
    select?: Readonly<Record<string, string | boolean>>;
    archived?: boolean;
  },
): Promise<{ ok: true }> =>
  send(`/api/sessions/${sessionId}`, "PATCH", tuning);

/**
 * `readAt` is where it actually landed, which is not always where it was asked
 * to. A harness with no safe point cannot fold a "turn" in, so it waits.
 */
export const message = (
  sessionId: string,
  body: { message: string; priority: Priority },
): Promise<{ ok: true; readAt: Priority }> =>
  json<{ ok: true; readAt: Priority }>(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const credentials = (): Promise<readonly Credential[]> =>
  json<readonly Credential[]>("/api/credentials");

export const saveCredential = (id: string, value: string): Promise<{ ok: true }> =>
  send(`/api/credentials/${id}`, "PUT", { value });

/**
 * Every entry committed after `afterSeq`.
 *
 * EventSource reconnects to the URL it was given, so `after` is only ever the
 * position at first connect and every reconnect replays from there. The
 * sequence number is the whole protocol: the caller drops anything at or
 * behind what it already holds.
 */
export function entries(sessionId: string, afterSeq: number, onEntry: (entry: Stored) => void): () => void {
  const source = new EventSource(`/api/sessions/${sessionId}/events?after=${afterSeq}`);
  source.onmessage = (event) => onEntry(JSON.parse(event.data) as Stored);
  return () => source.close();
}
