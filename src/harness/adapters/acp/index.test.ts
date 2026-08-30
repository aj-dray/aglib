import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandboxProvider } from "../../../sandbox/adapters/local.js";
import type { Sandbox } from "../../../sandbox/sandbox.js";
import type { Entry, Stored } from "../../../session/entry.js";
import { createAcpHarness, type AcpConfigOption } from "./index.js";

const root = await mkdtemp(join(tmpdir(), "aglib-acp-"));

/**
 * An agent that answers the four calls a turn makes and writes down which
 * method it was asked to select a model with.
 *
 * The two shapes are the two protocol versions: `models` on the session is what
 * the field was called before it became one entry in `configOptions`. Both
 * publish choices, so only the agent can say which method it understands — and
 * that is the whole point of the test.
 */
async function fakeAgent(shape: "configOptions" | "models"): Promise<string> {
  const path = join(root, `agent-${shape}.mjs`);
  const published = shape === "configOptions"
    ? `{ configOptions: [{ id: "model", name: "Model", category: "model", currentValue: "small",
         options: [{ id: "small", name: "Small" }, { id: "large", name: "Large" }] }] }`
    : `{ models: { currentModelId: "small",
         availableModels: [{ modelId: "small", name: "Small" }, { modelId: "large", name: "Large" }] } }`;
  await writeFile(path, `
    const seen = [];
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (let cut = buffer.indexOf("\\n"); cut >= 0; cut = buffer.indexOf("\\n")) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        seen.push(request.method);
        const reply = (result) =>
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        if (request.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: {} });
        else if (request.method === "session/new") reply({ sessionId: "s1", ...${published} });
        else if (request.method === "session/set_model") reply({});
        else if (request.method === "session/set_config_option") reply({});
        else if (request.method === "session/prompt") {
          // What it was asked, so the assertion reads the wire and not a mock.
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "s1", update: { sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: seen.join(",") } },
          } }) + "\\n");
          reply({ stopReason: "end_turn" });
        } else if (request.id !== undefined) reply({});
      }
    });
  `);
  return path;
}

/** The smallest context a turn needs: it commits to an array and never drains. */
function context(sandbox: Sandbox) {
  const committed: Entry[] = [];
  return {
    committed,
    value: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      instructions: "",
      history: () => [],
      entries: (): readonly Stored[] => [],
      commit: async (entries: readonly Entry[]) => { committed.push(...entries); },
      emit: () => {},
      signal: new AbortController().signal,
      sandbox,
    },
  };
}

async function selectModel(shape: "configOptions" | "models", model: string) {
  const created = await createLocalSandboxProvider({ root }).create({
    isolation: "none", network: { mode: "unrestricted" },
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  const options: AcpConfigOption[][] = [];
  const harness = createAcpHarness({
    id: `fake-${shape}`,
    agent: { command: [process.execPath, await fakeAgent(shape)] },
    sandbox: created.value,
    model,
    onConfig: (published) => { options.push([...published]); },
  });
  const { committed, value } = context(created.value);
  const result = await harness.run({ ...value, instructions: "go" } as never);
  await created.value.close();
  return { result, committed, options };
}

test("acp: a model published the old way is set the old way", async () => {
  const { result, committed } = await selectModel("models", "large");
  expect(result.status).toBe("completed");
  // An agent on that version has never heard of session/set_config_option, so
  // asking it that way is a request it answers with an error, not a model.
  const said = committed.map((entry) => JSON.stringify(entry)).join(" ");
  expect(said).toContain("session/set_model");
  expect(said).not.toContain("session/set_config_option");
});

test("acp: a model published as a config option is set as one", async () => {
  const { result, committed } = await selectModel("configOptions", "large");
  expect(result.status).toBe("completed");
  const said = committed.map((entry) => JSON.stringify(entry)).join(" ");
  expect(said).toContain("session/set_config_option");
  expect(said).not.toContain("session/set_model");
});

test("acp: both shapes are reported to the caller as one model selector", async () => {
  for (const shape of ["models", "configOptions"] as const) {
    const { options } = await selectModel(shape, "large");
    const selector = options.flat().find((option) => option.category === "model");
    expect(selector?.choices?.map((choice) => choice.id)).toEqual(["small", "large"]);
  }
});

test("acp: a model the agent does not offer fails naming what it does", async () => {
  const { result } = await selectModel("configOptions", "enormous");
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.message).toContain("small");
  expect(result.error.retryable).toBe(false);
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });
