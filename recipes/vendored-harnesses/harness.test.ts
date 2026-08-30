import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { runAgent, type Agent } from "aglib";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { serveAnthropicWire } from "./wire.ts";
import { createClaudeCodeHarness } from "./claude-code.ts";
import { createPiHarness } from "./pi.ts";
import { sandboxTools } from "./tools.ts";

test("Claude Code keeping its own tools refuses a sandbox it cannot reach", async () => {
  // Nothing is started: the refusal is the point. Its built-in tools run in
  // this process, so calling a container "contained" while they are in place
  // would be the simulated guarantee this library exists to avoid.
  const harness = createClaudeCodeHarness({
    sandbox: { isolation: "container", root: "/home/user" } as never,
    tools: "theirs",
  });
  const result = await harness.run({
    sessionId: "s", runId: "r", instructions: "",
    history: () => [], entries: () => [],
    commit: async () => {}, emit: () => {}, signal: new AbortController().signal,
  });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.code).toBe("unsupported");
});

test("only the harness that can be seeded from the log claims recovery", () => {
  const claude = createClaudeCodeHarness({ sandbox: { isolation: "none" } as never, tools: "ours" });
  const pi = createPiHarness({ baseUrl: "http://127.0.0.1:1", token: "t" });

  // Claude Code owns its context, so an interrupted run is over and `runAgent`
  // closes the session rather than handing it out again. Pi's transcript is
  // assigned from committed entries every activation, so it can be continued.
  expect(claude.recovery).toBe("none");
  expect(pi.recovery).toBe("history");
});

/**
 * The claim, run: a vendor harness inside our log, using our sandbox, on a
 * model its own library never heard of.
 *
 * Two gates, like every other live case here — `bun run check` is hermetic.
 */
const live = process.env["AGLIB_LIVE_MODEL"] === "1" ? process.env["OPENROUTER_API_KEY"] : undefined;
const liveTest = live ? test : test.skip;

for (const which of ["claude-code", "pi"] as const) {
  liveTest(`${which} runs in our log, with our hands, on a model behind the port`, async () => {
    const provider = createLocalSandboxProvider({ root: process.cwd() });
    const opened = await provider.create({ isolation: "none", network: { mode: "unrestricted" } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const sandbox = opened.value;

    const wire = serveAnthropicWire({
      model: createOpenRouterModel({ apiKey: live!, model: "anthropic/claude-sonnet-5", appName: "aglib-vendored-harnesses" }),
    });
    const instructions = "You are a careful assistant working inside a sandbox. Be brief.";
    const agent: Agent = which === "pi"
      ? {
          id: "t", version: "1", instructions,
          harness: createPiHarness({ baseUrl: wire.url, token: wire.token }),
          tools: sandboxTools(sandbox),
        }
      : {
          id: "t", version: "1", instructions,
          harness: createClaudeCodeHarness({
            sandbox, tools: "ours",
            env: {
              ...process.env as Record<string, string>,
              ANTHROPIC_BASE_URL: wire.url,
              ANTHROPIC_AUTH_TOKEN: wire.token,
              ANTHROPIC_API_KEY: wire.token,
              ANTHROPIC_MODEL: "claude-sonnet-5",
              ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
            },
          }),
        };

    const database = new Database(":memory:");
    const store = createSqliteStore({ database });
    const sessionId = crypto.randomUUID();
    const run = runAgent({
      agent, store, sessionId,
      input: "Run `echo aglib-was-here` with bash, then report exactly what it printed.",
    });
    for await (const _ of run) { /* the log is the record */ }
    const result = await run.result;

    await wire.close();
    await sandbox.close();
    expect(result.status).toBe("completed");

    // The point of wrapping a vendor harness at all: what it did is in *our*
    // log, in our vocabulary, whoever's loop produced it.
    const types = (database.query("SELECT body FROM entries ORDER BY seq").all() as { body: string }[])
      .map((row) => (JSON.parse(row.body) as { type: string }).type);
    expect(types).toContain("assistant");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");
    await store.close();
  }, 300_000);
}
