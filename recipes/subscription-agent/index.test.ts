import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["AGLIB_SUBSCRIPTION_HOME"] = await mkdtemp(join(tmpdir(), "aglib-subscription-"));
const { environment, harnessFor, main, parseArguments } = await import("./index.ts");

test("each vendor's process gets its credential and its state directory, and nothing else of ours", () => {
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat-test";
  process.env["SOME_OTHER_SECRET"] = "leak";
  const claude = environment("claude");
  expect(claude["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat-test");
  expect(claude["CLAUDE_CONFIG_DIR"]).toContain("claude");
  expect(Object.values(environment("codex"))).not.toContain("sk-ant-oat-test");
  expect(Object.values(claude)).not.toContain("leak");
  delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  delete process.env["SOME_OTHER_SECRET"];
});

test("a Codex turn runs our bash through our sandbox and answers", async () => {
  const sent: string[] = [];
  const connect = () => {
    const out: unknown[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const push = (message: unknown) => { out.push(message); wake?.(); };
    return {
      send(message: unknown) {
        const record = message as { id?: number; method?: string; result?: { contentItems: { text: string }[] } };
        if (!record.method) { push({ method: "item/completed", params: { turnId: "t1", item: { type: "agentMessage", text: `It says ${record.result!.contentItems[0]!.text.trim()}.` } } }); push({ method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } }); return; }
        sent.push(record.method);
        if (record.method === "thread/start") push({ id: record.id, result: { thread: { id: "th1" } } });
        else if (record.method === "turn/start") { push({ id: record.id, result: { turn: { id: "t1" } } }); push({ id: 900, method: "item/tool/call", params: { callId: "c1", tool: "bash", arguments: { command: "echo hello" } } }); }
        else if (record.id !== undefined) push({ id: record.id, result: {} });
      },
      messages: (async function* () { while (true) { while (out.length) yield out.shift() as never; if (closed) return; await new Promise<void>((resolve) => { wake = resolve; }); } })(),
      close() { closed = true; wake?.(); },
    };
  };
  const written: string[] = [];
  const choice = parseArguments(["--vendor", "codex", "--model", "gpt-6", "say", "hello"]).choice;
  await main("say hello", { choice, harness: harnessFor(choice, { connect }), write: (text) => written.push(text) });
  expect(written.join("")).toContain("It says hello.");
  expect(sent).toContain("thread/start");
});
