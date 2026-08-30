/**
 * Remembered facts. An application table, two tools, and one block of
 * run-scoped context — this is the whole of "long-term memory", and none of it
 * is library surface.
 */
import { defineTool, type Tool } from "aglib";
import { z } from "zod";
import type { Database } from "./db.ts";

export interface Fact { id: number; text: string; addedAt: string }

export function factTools(database: Database): { tools: readonly Tool[]; all(): Promise<readonly Fact[]> } {
  const all = async () => database.query<Fact>(`SELECT id, text, addedAt FROM facts ORDER BY id`);
  return {
    all,
    tools: [
      defineTool({
        name: "remember",
        description: "Store a durable fact about the operator or their work. Use sparingly, for things worth recalling in future conversations.",
        schema: z.object({ text: z.string().min(3).max(500) }),
        execute: ({ text }) => {
          database.run(`INSERT INTO facts (text, addedAt) VALUES (?, ?)`, [text, new Date().toISOString()]);
          // Facts land in the cached prefix, which is fixed for this run.
          return { content: "Remembered. It will be in context from the next conversation." };
        },
      }),
      defineTool({
        name: "forget",
        description: "Delete a remembered fact by id.",
        schema: z.object({ id: z.number().int() }),
        execute: ({ id }) => {
          database.run(`DELETE FROM facts WHERE id = ?`, [id]);
          return { content: `Forgot fact ${id}.` };
        },
      }),
    ],
  };
}

export function renderFacts(facts: readonly Fact[]): string {
  if (!facts.length) return "<facts>none recorded</facts>";
  return `<facts>\n${facts.map((f) => `${f.id}. ${f.text}`).join("\n")}\n</facts>`;
}
