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
import type { Sink } from "aglib/render";
import { sandboxKinds, type SandboxKind } from "./sandbox.ts";

export const providers = ["openrouter", "openai", "anthropic"] as const;
export type Provider = (typeof providers)[number];

export interface Choice {
  provider: Provider;
  model: string;
  sandbox: SandboxKind;
  effort?: ModelRequest["effort"];
  /** How much of the run to show. `debug` is for working out why it did that. */
  detail?: Sink["detail"];
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
  return createOpenRouterModel({ apiKey, model, appName: "aglib-native-agent" });
}

/** `--provider x --model y --effort high --sandbox docker --detail detailed` — the rest is the task. */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  // Flags that take no value have to be named, or one swallows the task as its
  // argument and the agent is asked nothing.
  const valueless = new Set<string>();
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

  const detail = flags.get("detail") as Sink["detail"] | undefined;
  if (detail && !["minimal", "standard", "detailed"].includes(detail)) {
    throw new Error(`Unknown detail '${detail}'. One of: minimal, standard, detailed`);
  }

  return {
    choice: {
      provider, model: flags.get("model") || defaultModel[provider], sandbox,
      // A conversation shows the conversation. The internal stream is a
      // question someone asks for with `--detail standard`, not the default view
      // of a personal agent talking to its operator.
      ...(effort ? { effort } : {}), detail: detail ?? "minimal",
    },
    task: words.join(" "),
  };
}
