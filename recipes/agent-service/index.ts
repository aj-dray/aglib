/**
 * The service: an HTTP surface and a pool of workers over one shared store.
 *
 * Both halves run in one process because interrupting an agent has to reach
 * the run that is happening. Splitting them is a store-side signal away, and
 * `send`'s own answer already says which case it took.
 */
import { Database } from "bun:sqlite";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import type { Store } from "aglib/store";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPostgresStore } from "./store.ts";
import { serve } from "./server.ts";
import { work } from "./worker.ts";
import { sandboxRoot } from "./sandbox.ts";
import { serviceHome } from "./home.ts";
import { recipeMarker } from "../manifest.ts";
import { seedFromFiles } from "./credentials.ts";
import type { Running } from "./tools.ts";

export async function openStore(): Promise<Store> {
  const url = process.env["DATABASE_URL"];
  if (url) return createPostgresStore({ url });
  const path = process.env["SERVICE_DB"] ?? join(serviceHome, "service.db");
  mkdirSync(dirname(path), { recursive: true });
  return createSqliteStore({ database: new Database(path) });
}

export async function main(): Promise<void> {
  // A `.env` is a convenience for the first run, not a second source of truth.
  const seeded = seedFromFiles();
  if (seeded.length) console.log(`took ${seeded.join(", ")} from .env into the credential store`);

  const store = await openStore();
  const running: Running = new Map();
  const workers = Number(process.env["WORKERS"] ?? 4);
  const shutdown = new AbortController();

  const url = serve({ store, running, port: Number(process.env["PORT"] ?? 3000) });
  console.log(`agent-service on ${url}`);
  console.log(`sandboxes in ${sandboxRoot}`);
  console.log(recipeMarker("agent-service"));

  // The application owns process placement and worker count. aglib spawns nothing.
  await Promise.all(Array.from({ length: workers }, () =>
    work({ store, running, serviceUrl: url, signal: shutdown.signal })));
}

if (import.meta.main) await main();
