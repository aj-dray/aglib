/**
 * Picking a model at the command line.
 *
 * Three providers behind one port: two share the OpenAI wire and differ only by
 * base URL, and Anthropic has its own. `effort` is the port's three levels, and
 * a provider that cannot honour it ignores it rather than failing.
 */
import { createOpenAiCompatibleModel, createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { createAnthropicModel } from "aglib/model/adapters/anthropic";
import type { Model, ModelRequest } from "aglib/model";

export const providers = ["openrouter", "openai", "anthropic"] as const;
export type Provider = (typeof providers)[number];

export interface ModelChoice {
  provider: Provider;
  model: string;
  effort?: ModelRequest["effort"];
}

const defaultModel: Record<Provider, string> = {
  openrouter: "deepseek/deepseek-v4-flash",
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5-20251001",
};

const keyFor: Record<Provider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export function createChosenModel(choice: ModelChoice): Model {
  const apiKey = process.env[keyFor[choice.provider]];
  if (!apiKey) throw new Error(`${keyFor[choice.provider]} is not set (needed for --provider ${choice.provider})`);
  const model = choice.model;

  if (choice.provider === "anthropic") return createAnthropicModel({ apiKey, model });
  if (choice.provider === "openai") {
    return createOpenAiCompatibleModel({ apiKey, baseUrl: "https://api.openai.com/v1", model });
  }
  return createOpenRouterModel({ apiKey, model, appName: "aglib-personal-agent" });
}

/** `--provider x --model y --effort high` — everything else is the task. */
export function parseArguments(argv: readonly string[]): { choice: ModelChoice; task: string } {
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
  const effort = flags.get("effort") as ModelRequest["effort"] | undefined;
  if (effort && !["low", "medium", "high"].includes(effort)) {
    throw new Error(`Unknown effort '${effort}'. One of: low, medium, high`);
  }

  return {
    choice: {
      provider,
      model: flags.get("model") || defaultModel[provider],
      ...(effort ? { effort } : {}),
    },
    task: words.join(" "),
  };
}
