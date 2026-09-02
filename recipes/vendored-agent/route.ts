/**
 * Where Pi's own requests go.
 *
 * A pi-ai model is a *description* of an endpoint rather than a client — an id,
 * a wire and a base URL — so pointing its loop at a provider is three fields
 * and no translation. That this file is short is the finding, not an omission:
 * a vendor whose model is a value needs nothing built for it.
 */
export type Provider = "openrouter" | "openai" | "anthropic";

export interface Route {
  /** Where requests go. */
  baseUrl: string;
  token: string;
  /** The wire spoken there. Pi speaks several and is told which. */
  api: "anthropic-messages" | "openai-completions";
}

const keyFor: Readonly<Record<Provider, string>> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const endpoints: Readonly<Record<Provider, Omit<Route, "token">>> = {
  // OpenRouter on the OpenAI wire, which is the provider pi-ai already ships a
  // descriptor for. It serves the Anthropic wire too; using the one the vendor
  // already knows costs nothing.
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
};

export function routeTo(provider: Provider): Route {
  const token = process.env[keyFor[provider]];
  if (!token) throw new Error(`${keyFor[provider]} is not set (needed for --provider ${provider})`);
  return { ...endpoints[provider], token };
}
