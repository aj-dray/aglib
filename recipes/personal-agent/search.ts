/**
 * Cross-session recall: FTS5 over the log, plus a generated summary per session.
 *
 * The opinionation is in what is NOT indexed. Tool results are excluded — file
 * dumps, command output and stack traces swamp every query with irrelevant
 * exact matches. Only what the operator and the assistant actually said is
 * searchable, and every hit carries `seq` so it points back at the exact place
 * in the log to reopen.
 *
 * Not embeddings, not a vector service: FTS5 ships inside SQLite, needs no key
 * and no background job. If it proves insufficient, the implementation behind
 * `search_sessions` changes and the tool signature does not.
 */
import { defineTool, textOf, type Content, type Tool } from "aglib";
import type { Store } from "aglib/store";
import type { Entry, Stored } from "aglib/session";

/** What this app keeps on a session. aglib stores it and never reads it. */
export type SessionMetadata = { title: string | null; summary: string | null };
import { collect, type Model } from "aglib/model";
import { z } from "zod";
import type { Database } from "./db.ts";

type SessionHit = { sessionId: string; seq: number; title: string | null; excerpt: string };

export function searchTools(database: Database, store: Store): readonly Tool[] {
  return [
    defineTool({
      name: "search_sessions",
      description: "Full-text search across every past conversation. Returns session ids and matching excerpts.",
      annotations: { readOnly: true },
      schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(5) }),
      execute: ({ query, limit }) => {
        const hits = database.query<SessionHit>(
          `SELECT f.sessionId, f.seq, json_extract(s.metadata, '$.title') AS title,
                  snippet(sessions_fts, 3, '«', '»', '…', 12) AS excerpt
             FROM sessions_fts f
             LEFT JOIN sessions s ON s.id = f.sessionId
            WHERE sessions_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
          [query, limit],
        );
        return {
          content: hits.length ? hits.map(renderHit).join("\n\n") : "No matching sessions.",
          details: hits,
        };
      },
    }),

    defineTool({
      name: "read_session",
      description: "Read a past conversation from a point in its history. Use after search_sessions.",
      annotations: { readOnly: true },
      schema: z.object({
        sessionId: z.string(),
        fromSeq: z.number().int().default(0),
        limit: z.number().int().min(1).max(200).default(40),
      }),
      execute: async ({ sessionId, fromSeq, limit }) => {
        const read = await store.read({ sessionId, afterSeq: fromSeq });
        if (!read.ok) return { content: `Cannot read session: ${read.error.message}`, isError: true };
        const lines = read.value.entries.slice(0, limit).map(renderEntry).filter(Boolean);
        return { content: lines.join("\n") || "(nothing recorded after that point)" };
      },
    }),
  ];
}

/** Populates the app's index from the committed log. Runs after a session finishes. */
export function indexRun(input: { database: Database; entries: readonly Stored<Entry>[]; sessionId: string }): void {
  for (const entry of input.entries) {
    const text = searchableText(entry);
    if (!text) continue;
    input.database.run(
      `INSERT INTO sessions_fts (sessionId, seq, role, text) VALUES (?, ?, ?, ?)`,
      [input.sessionId, entry.seq, entry.type === "assistant" ? "assistant" : "user", text],
    );
  }
}

/**
 * One model call, from the log, after the run. The library neither summarizes
 * nor titles anything — it only has to be readable, and the result goes back
 * as ordinary session metadata.
 */
export async function summarizeRun(input: {
  model: Model;
  entries: readonly Stored<Entry>[];
}): Promise<SessionMetadata> {
  const conversation = input.entries.map(renderEntry).filter(Boolean).join("\n");
  const outcome = await collect(input.model.generate({
    messages: [{
      role: "user",
      content: `Summarize this conversation for later retrieval. Reply with a single line title (max 8 words), then a blank line, then at most three sentences covering intent, decisions, and anything worth recalling.\n\n${conversation}`,
    }],
    maxOutputTokens: 300,
  }));
  if (!outcome.ok) return { title: null, summary: null };

  const [title = "", ...rest] = textOf(outcome.value.message.content).split("\n\n");
  return { title: title.trim().slice(0, 120), summary: rest.join("\n\n").trim() };
}

/** Only the conversation itself is searchable. Tool traffic is deliberately dropped. */
function searchableText(entry: Stored<Entry>): string | undefined {
  if (entry.type === "assistant") return textOf(entry.content) || undefined;
  if (entry.type === "run.started") return textOf(entry.input) || undefined;
  return undefined;
}

function renderEntry(entry: Stored<Entry>): string {
  if (entry.type === "run.started") return `[${entry.seq}] operator: ${textOf(entry.input)}`;
  if (entry.type === "assistant") {
    const calls = (entry.calls ?? []).map((call) => `→ ${call.name}(${call.arguments})`);
    return [`[${entry.seq}] assistant: ${textOf(entry.content)}`, ...calls].filter(Boolean).join("\n");
  }
  if (entry.type === "summary") return `[${entry.seq}] (earlier conversation compacted)\n${entry.content}`;
  return "";
}

function renderHit(hit: SessionHit): string {
  return [`${hit.title ?? "(untitled)"} — session ${hit.sessionId}, turn ${hit.seq}`, hit.excerpt].join("\n");
}
