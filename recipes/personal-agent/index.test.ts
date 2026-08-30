import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createFakeModel } from "aglib/model/adapters/fake";
import { main } from "./index.ts";

/**
 * Offline, deterministic, no credentials. The fake model stands in for the
 * provider; everything else — the log, the tools, the FTS index, the summary —
 * is the real thing.
 */
async function withHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "aglib-personal-"));
  const previous = process.env.AGENT_HOME;
  process.env.AGENT_HOME = home;
  try { return await body(home); }
  finally {
    if (previous === undefined) delete process.env.AGENT_HOME; else process.env.AGENT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("remembers a fact, and the next session is given it as context", async () => {
  await withHome(async (home) => {
    const remembering = createFakeModel([
      { calls: [{ callId: "c1", name: "remember", arguments: JSON.stringify({ text: "Prefers metric units." }) }] },
      { text: "Noted." },
      { text: "Metric preference recorded" }, // the summary call
    ]);
    await main("Remember I prefer metric units.", { model: remembering, write: () => {} });

    const facts = new Database(join(home, "agent.db")).query("SELECT text FROM facts").all() as { text: string }[];
    expect(facts.map((fact) => fact.text)).toEqual(["Prefers metric units."]);
  });
});

test("indexes what was said, and never indexes tool traffic", async () => {
  await withHome(async (home) => {
    const model = createFakeModel([
      { calls: [{ callId: "c1", name: "read_file", arguments: JSON.stringify({ path: "nope.txt" }) }] },
      { text: "The pricing model is usage-based." },
      { text: "Pricing discussion" },
    ]);
    await main("What did we decide about pricing?", { model, write: () => {} });

    const rows = new Database(join(home, "agent.db"))
      .query("SELECT role, text FROM sessions_fts ORDER BY seq").all() as { role: string; text: string }[];
    // The operator's question and the assistant's answer — not the failed file read.
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows.some((row) => row.text.includes("nope.txt"))).toBe(false);
    expect(rows[1]?.text).toContain("usage-based");
  });
});

test("a run whose model runs out of responses fails typed, and the log says so", async () => {
  await withHome(async (home) => {
    await expect(main("go", { model: createFakeModel([]), write: () => {} })).rejects.toThrow(/run failed/);
    const entries = new Database(join(home, "agent.db"))
      .query("SELECT body FROM entries ORDER BY seq").all() as { body: string }[];
    const types = entries.map((entry) => JSON.parse(entry.body).type as string);
    expect(types).toEqual(["run.started", "run.finished"]);
  });
});
