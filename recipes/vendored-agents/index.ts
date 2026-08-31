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
 * `coding-agents` is the other end of the same argument: any agent in the
 * registry, cheaply, keeping none of that.
 */
import { runAgent, type Agent, type RunResult } from "aglib";
import { renderRun, type Sink } from "aglib/render";
import { terminalSink, turnsFrom } from "aglib/terminal";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createOpenAiCompatibleModel, createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { createAnthropicModel } from "aglib/model/adapters/anthropic";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createDockerSandboxProvider } from "aglib/sandbox/adapters/docker";
import type { Model } from "aglib/model";
import type { Sandbox } from "aglib/sandbox";
import { Database } from "bun:sqlite";
import { recipeMarker } from "../manifest.ts";
import { anthropicRoute, piRoute } from "./route.ts";
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
  /** Answer once and exit, for someone at a terminal who wants the script behaviour. */
  once?: boolean;
  /** Route through the local Anthropic bridge even where the provider serves that wire itself. */
  bridge?: boolean;
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
  return createOpenRouterModel({ apiKey, model: choice.model, appName: "aglib-vendored-agents" });
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
  options: { choice?: Choice; model?: Model; sink?: Sink; turns?: AsyncIterable<string> } = {},
): Promise<string> {
  const choice = options.choice ?? defaultChoice;
  const sink: Sink = options.sink ?? terminalSink();
  const sandbox = await openSandbox(choice.sandbox);

  // Straight to the provider where one serves the wire, and through the bridge
  // only where none does. Both agents are told a base URL and a token either
  // way, and neither learns which of the three it got.
  const route = (choice.harness === "pi" ? piRoute : anthropicRoute)({
    provider: choice.provider,
    model: () => options.model ?? createChosenModel(choice),
    ...(choice.bridge ? { force: true } : {}),
  });

  // Worth saying out loud: routing through the bridge costs prompt caching and
  // real token counts, and a reader should know which one they got.
  (sink.status ?? sink.write)(`· via ${route.via}\n`);

  const instructions = "You are a careful assistant working inside a sandbox. Be brief and say what you did.";

  // Held for the life of this process, and no longer than that. An agent that
  // keeps its own context is continued by being handed the name it knows the
  // conversation by; where that name should live if the process restarts is a
  // question this recipe does not answer, because its store is in memory.
  let vendorSessionId: string | undefined;

  const agentFor = (): Agent => choice.harness === "pi"
    ? {
        id: "vendored-agents", version: "1", instructions,
        // Pi needs nothing here: `transcriptFor` assigns `state.messages` from
        // the committed log every activation, which is why it is the one vendor
        // harness that can declare `recovery: "history"`.
        harness: createPiHarness({
          baseUrl: route.baseUrl, token: route.token, api: route.api,
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
        id: "vendored-agents", version: "1", instructions,
        harness: createClaudeCodeHarness({
          sandbox,
          tools: choice.tools,
          // Its context lives over there, so continuing a conversation means
          // handing back the name it knows the conversation by.
          ...(vendorSessionId ? { resume: vendorSessionId } : {}),
          onSession: (id) => { vendorSessionId = id; },
          ...(choice.effort ? { effort: choice.effort } : {}),
          env: {
            ...process.env as Record<string, string>,
            ANTHROPIC_BASE_URL: route.baseUrl,
            ANTHROPIC_AUTH_TOKEN: route.token,
            // OpenRouter's guide is explicit that this must be empty, or the
            // SDK prefers it and talks to Anthropic with somebody else's key.
            ANTHROPIC_API_KEY: route.via === "openrouter" ? "" : route.token,
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
  let result: RunResult | undefined;
  for await (const input of options.turns ?? [task]) {
    // Rebuilt each turn, because `resume` is only known after the first one has
    // told us what the agent calls this conversation.
    result = await renderRun(runAgent({ agent: agentFor(), store, sessionId, key: "me", input }), sink);

  }

  await route.close();
  await sandbox.close();
  await store.close();
  if (result && result.status !== "completed") {
    throw new Error(result.status === "failed" ? `run failed: ${result.error.message}` : `run ${result.status}`);
  }
  return sessionId;
}

/** `--harness pi --tools both --sandbox docker` — everything else is the task. */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  // Flags taking no value must be named, or `--once "do the thing"` swallows
  // the task as `once`'s argument and the agent is asked nothing.
  const valueless = new Set(["once", "bridge"]);
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) { words.push(argument); continue; }
    const name = argument.slice(2);
    if (valueless.has(name)) { flags.set(name, "true"); continue; }
    flags.set(name, argv[index + 1] ?? "");
    index += 1;
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
      ...(flags.has("once") ? { once: true } : {}),
      ...(flags.has("bridge") ? { bridge: true } : {}),
    },
    task: words.join(" "),
  };
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· ${choice.harness} · tools ${choice.tools} · sandbox ${choice.sandbox} · ${choice.provider} · ${choice.model}`);
  // The same terminal every recipe here gets: a prompt for a person, one shot
  // for a pipe, and the argv task as the first turn either way.
  await main(task, { choice, turns: turnsFrom({ task, once: choice.once === true }).lines });
  console.log(recipeMarker("vendored-agents"));
}
