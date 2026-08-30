/**
 * Somebody else's agent, deeply integrated.
 *
 * Two vendor libraries wrapped as a `Harness`, running inside our log, our
 * sandbox and — through `serveAnthropicWire` — our model port. The claim this
 * recipe makes is that "use their agent" and "own the session" are not a
 * trade: pick a harness, and what changes is which control points you keep.
 *
 * | harness | their tools | ours | prompt | resume |
 * | --- | --- | --- | --- | --- |
 * | `claude-code` | by name, inside its process | an in-process MCP server | its preset with ours appended | none |
 * | `pi` | as values, re-pointed at our sandbox | the same executor | ours | from the log |
 *
 * `acp-switcher` is the other end of the same argument: any agent in the
 * registry, cheaply, keeping none of that.
 */
import { runAgent, type Agent } from "aglib";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createOpenAiCompatibleModel, createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { createAnthropicModel } from "aglib/model/adapters/anthropic";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createDockerSandboxProvider } from "aglib/sandbox/adapters/docker";
import type { Model } from "aglib/model";
import type { Sandbox } from "aglib/sandbox";
import { Database } from "bun:sqlite";
import { recipeMarker } from "../manifest.ts";
import { serveAnthropicWire } from "./wire.ts";
import { createClaudeCodeHarness } from "./claude-code.ts";
import { createPiHarness } from "./pi.ts";
import { sandboxTools } from "./tools.ts";
import { piCodingTools } from "./pi-tools.ts";

export const harnessIds = ["claude-code", "pi"] as const;
export type HarnessId = (typeof harnessIds)[number];

export interface Choice {
  harness: HarnessId;
  tools: "ours" | "theirs" | "both";
  sandbox: "local" | "docker";
  provider: "openrouter" | "openai" | "anthropic";
  model: string;
  effort?: "low" | "medium" | "high";
}

export const defaultChoice: Choice = {
  harness: "claude-code",
  tools: "ours",
  sandbox: "local",
  provider: "openrouter",
  model: "anthropic/claude-sonnet-5",
};

const keyFor = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;

export function createChosenModel(choice: Choice): Model {
  const apiKey = process.env[keyFor[choice.provider]];
  if (!apiKey) throw new Error(`${keyFor[choice.provider]} is not set (needed for --provider ${choice.provider})`);
  if (choice.provider === "anthropic") return createAnthropicModel({ apiKey, model: choice.model });
  if (choice.provider === "openai") {
    return createOpenAiCompatibleModel({ apiKey, baseUrl: "https://api.openai.com/v1", model: choice.model });
  }
  return createOpenRouterModel({ apiKey, model: choice.model, appName: "aglib-vendored-harnesses" });
}

async function openSandbox(kind: Choice["sandbox"]): Promise<Sandbox> {
  const provider = kind === "docker"
    ? createDockerSandboxProvider({ image: process.env["AGLIB_DOCKER_IMAGE"] ?? "alpine:3" })
    : createLocalSandboxProvider({ root: process.cwd() });
  const sandbox = await provider.create({
    isolation: kind === "docker" ? "required" : "none",
    network: { mode: "unrestricted" },
  });
  if (!sandbox.ok) throw new Error(`sandbox (${kind}): ${sandbox.error.message}`);
  return sandbox.value;
}

export async function main(
  task: string,
  options: { choice?: Choice; model?: Model; write?: (line: string) => void } = {},
): Promise<string> {
  const choice = options.choice ?? defaultChoice;
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const sandbox = await openSandbox(choice.sandbox);

  // One bridge, both harnesses. Neither vendor library learns which provider
  // answered, and neither had to be told how to talk to it.
  const wire = serveAnthropicWire({ model: options.model ?? createChosenModel(choice) });

  const instructions = "You are a careful assistant working inside a sandbox. Be brief and say what you did.";
  const agent: Agent = choice.harness === "pi"
    ? {
        id: "vendored-harnesses", version: "1", instructions,
        harness: createPiHarness({
          baseUrl: wire.url, token: wire.token,
          ...(choice.effort ? { effort: choice.effort } : {}),
        }),
        // Every tool goes through the executor, theirs included: `pi-tools.ts`
        // adapts Pi's own bash, read, edit and write and backs them with the
        // sandbox, so they are validated and gated like anything we wrote.
        tools: [
          ...(choice.tools === "ours" ? [] : piCodingTools(sandbox)),
          ...(choice.tools === "theirs" ? [] : sandboxTools(sandbox)),
        ],
      }
    : {
        id: "vendored-harnesses", version: "1", instructions,
        harness: createClaudeCodeHarness({
          sandbox,
          tools: choice.tools,
          ...(choice.effort ? { effort: choice.effort } : {}),
          env: {
            ...process.env as Record<string, string>,
            ANTHROPIC_BASE_URL: wire.url,
            ANTHROPIC_AUTH_TOKEN: wire.token,
            ANTHROPIC_API_KEY: wire.token,
            ANTHROPIC_MODEL: "claude-sonnet-5",
            ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
          },
        }),
        // Its tools are its own, reached through an in-process MCP server. The
        // executor stays empty on purpose: two routes to a tool would be two
        // places to authorize one.
      };

  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  const sessionId = crypto.randomUUID();
  const run = runAgent({ agent, store, sessionId, key: "me", input: task });
  // The stream is the output. Printing `result.output` afterwards said
  // everything twice — one answer, arriving in two ways.
  for await (const update of run) if (update.type === "text.delta") write(update.text);
  write("\n");

  const result = await run.result;
  await wire.close();
  await sandbox.close();
  await store.close();
  if (result.status !== "completed") {
    throw new Error(result.status === "failed" ? `run failed: ${result.error.message}` : `run ${result.status}`);
  }
  return sessionId;
}

/** `--harness pi --tools both --sandbox docker` — everything else is the task. */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith("--")) { flags.set(argument.slice(2), argv[index + 1] ?? ""); index += 1; }
    else words.push(argument);
  }
  const harness = (flags.get("harness") ?? defaultChoice.harness) as HarnessId;
  if (!harnessIds.includes(harness)) {
    throw new Error(`Unknown harness '${harness}'. One of: ${harnessIds.join(", ")}`);
  }
  const effort = flags.get("effort") as Choice["effort"];
  return {
    choice: {
      ...defaultChoice,
      harness,
      tools: (flags.get("tools") ?? defaultChoice.tools) as Choice["tools"],
      sandbox: (flags.get("sandbox") ?? defaultChoice.sandbox) as Choice["sandbox"],
      provider: (flags.get("provider") ?? defaultChoice.provider) as Choice["provider"],
      model: flags.get("model") || defaultChoice.model,
      ...(effort ? { effort } : {}),
    },
    task: words.join(" "),
  };
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· ${choice.harness} · tools ${choice.tools} · sandbox ${choice.sandbox} · ${choice.provider} · ${choice.model}`);
  await main(task, { choice });
  console.log(recipeMarker("vendored-harnesses"));
}
