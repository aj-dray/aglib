/**
 * Picking a model and a sandbox at the command line.
 *
 * Three providers behind one port: two share the OpenAI wire and differ only by
 * base URL, and Anthropic has its own. A model is a value here, not a name the
 * library resolves — which is why choosing one is choosing which function to
 * call rather than setting a string somewhere.
 */
import { createOpenAiCompatibleModel, createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { createAnthropicModel } from "aglib/model/adapters/anthropic";
import type { Model, ModelRequest } from "aglib/model";
import { sandboxKinds, type SandboxKind } from "./sandbox.ts";

export const providers = ["openrouter", "openai", "anthropic"] as const;
export type Provider = (typeof providers)[number];

export interface Choice {
  provider: Provider;
  model: string;
  sandbox: SandboxKind;
  effort?: ModelRequest["effort"];
}

const defaultModel: Record<Provider, string> = {
  openrouter: "deepseek/deepseek-v4-flash",
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5",
};

const keyFor: Record<Provider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export function createChosenModel(choice: Choice): Model {
  const apiKey = process.env[keyFor[choice.provider]];
  if (!apiKey) throw new Error(`${keyFor[choice.provider]} is not set (needed for --provider ${choice.provider})`);
  const model = choice.model;

  if (choice.provider === "anthropic") return createAnthropicModel({ apiKey, model });
  if (choice.provider === "openai") {
    return createOpenAiCompatibleModel({ apiKey, baseUrl: "https://api.openai.com/v1", model });
  }
  return createOpenRouterModel({ apiKey, model, appName: "aglib-native-agents" });
}

/** `--provider x --model y --effort high --sandbox docker` — everything else is the task. */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith("--")) { flags.set(argument.slice(2), argv[index + 1] ?? ""); index += 1; }
    else words.push(argument);
  }

  const provider = (flags.get("provider") ?? "openrouter") as Provider;
  if (!providers.includes(provider)) {
    throw new Error(`Unknown provider '${provider}'. One of: ${providers.join(", ")}`);
  }
  const sandbox = (flags.get("sandbox") ?? "local") as SandboxKind;
  if (!sandboxKinds.includes(sandbox)) {
    throw new Error(`Unknown sandbox '${sandbox}'. One of: ${sandboxKinds.join(", ")}`);
  }
  const effort = flags.get("effort") as ModelRequest["effort"] | undefined;
  if (effort && !["low", "medium", "high"].includes(effort)) {
    throw new Error(`Unknown effort '${effort}'. One of: low, medium, high`);
  }

  return {
    choice: { provider, model: flags.get("model") || defaultModel[provider], sandbox, ...(effort ? { effort } : {}) },
    task: words.join(" "),
  };
}
