import { test } from "bun:test";
import { SQL } from "bun";
import { defineStoreConformance } from "aglib/store/conformance";
import { createPostgresStore } from "./store.ts";

/**
 * The Postgres store, held to the same contract as the one in the package.
 *
 * This is the point of shipping the suite. This adapter is written from the
 * public interface alone, by someone outside the package, and reading the
 * interface is not enough: it renewed a claim when a run started rather than
 * on every write it made, which looks correct until a turn outlasts the window
 * and a second worker is handed a session that is still running. The suite said
 * so; the prose had said so too, and prose does not fail.
 *
 * Skipped without `DATABASE_URL`, because a recipe test requires no service.
 */
const url = process.env["DATABASE_URL"];

for (const item of defineStoreConformance({
  async open({ claimMs }) {
    const store = await createPostgresStore({ url: url!, claimMs });
    const admin = new SQL(url!);
    await admin`TRUNCATE sessions, entries, deliveries`;
    await admin.end();
    return store;
  },
  // `LISTEN`/`NOTIFY` on a held connection, so a worker on any process is told.
  changes: "deployment",
  peer: ({ claimMs }) => createPostgresStore({ url: url!, claimMs }),
})) {
  const name = `postgres: ${item.name}`;
  if (url) test(name, item.run, 30_000);
  else test.skip(`${name} (no DATABASE_URL)`, item.run);
}
