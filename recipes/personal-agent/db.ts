/**
 * One SQLite file holds both schemas.
 *
 * aglib creates and owns `sessions` and `entries`. This file creates the
 * application's `facts` and `sessions_fts` beside them. That is only possible
 * because the store accepts an open database handle rather than a path — which
 * is the interface decision that lets an application index and join against
 * its own agent's history instead of reverse-engineering it.
 */
import { Database as Sqlite } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Database {
  handle: Sqlite;
  query<T>(sql: string, parameters?: readonly unknown[]): T[];
  run(sql: string, parameters?: readonly unknown[]): void;
}

const applicationSchema = `
  CREATE TABLE IF NOT EXISTS facts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    text    TEXT NOT NULL,
    addedAt TEXT NOT NULL
  );

  -- Contentless-adjacent FTS: the text lives here, and (sessionId, seq) points
  -- back at the log so a hit can reopen the conversation at that exact turn.
  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    sessionId UNINDEXED,
    seq       UNINDEXED,
    role      UNINDEXED,
    text,
    tokenize  = 'porter unicode61'
  );
`;

export async function openDatabase(path: string): Promise<Database> {
  await mkdir(dirname(path), { recursive: true });
  const handle = new Sqlite(path, { create: true });
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec(applicationSchema);
  return {
    handle,
    query: <T>(sql: string, parameters: readonly unknown[] = []) =>
      handle.query(sql).all(...(parameters as never[])) as T[],
    run: (sql, parameters = []) => { handle.query(sql).run(...(parameters as never[])); },
  };
}
