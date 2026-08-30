/**
 * The harnesses this service can start, each one already configured.
 *
 * A harness is not a construction kit. It is an adapter, a provider, a system
 * prompt and a credential, all decided here — so starting a session is choosing
 * one name, and the only things left to pick are which model it runs and how
 * hard it thinks. Both of those are changed inside the session, because a
 * conversation is where you find out you wanted a bigger model.
 *
 * This replaced a table of fourteen capabilities per harness. That table
 * existed to keep a form honest while an operator assembled a provider, a
 * model, an effort and a prompt by hand; with the combinations enumerated here
 * instead of assembled there, it had one runtime reader left — and what it read
 * was `adapter === "acp"` spelled at length. What each adapter gives up is
 * still worth knowing, and now lives in `docs/ARCHITECTURE.md`, which is where
 * a fact about the library's adapters belongs.
 */
import type { Effort } from "./effort.ts";

export type HarnessId =
  | "native"
  | "claude-code"
  | "claude-code-acp"
  | "codex"
  | "opencode"
  | "cursor"
  | "pi";

export type { Effort };

/** A model the session offers. An empty list means this agent chooses its own. */
export interface ModelChoice {
  id: string;
  title: string;
}

export interface Harness {
  id: HarnessId;
  title: string;
  summary: string;
  /**
   * How it is driven, and therefore where it runs.
   *
   * "native" is our loop, in this process, with our tools.
   * "sdk" is a vendor library in this process whose built-in tools we remove
   *   and replace with sandbox-backed ones.
   * "acp" is an agent started *inside* the sandbox and spoken to over the Agent
   *   Client Protocol, because its own tools cannot be taken away — and because
   *   the protocol carries no system prompt, its orientation goes in the first
   *   message instead.
   */
  adapter: "native" | "sdk" | "acp";
  /**
   * What the operator connects for this harness, in Settings. Fixed here: a
   * provider is a property of the harness, not a per-session choice.
   *
   * The list is alternatives — any one of them will do — which is why callers
   * pass it to `environmentFor` as a single requirement. Claude Code takes a
   * subscription token or an API key and does not care which. Empty means the
   * agent authenticates itself.
   */
  credential: readonly string[];
  models: readonly ModelChoice[];
  defaultModel?: string;
  effort: boolean;
  /** Argv, for an agent started inside the sandbox. */
  command?: readonly string[];
  /** The agent's own mode. "default" on Claude means "ask before acting". */
  mode?: string;
  /** Why this cannot be started, when what is missing is not a credential. */
  unavailable?: string;
  /** Non-secret configuration for a run. Credentials are composed separately. */
  environment?(input: { model?: string; effort?: Effort }): Record<string, string>;
}

/** Claude Code's thinking budget, by our three levels. Verified against the running agent. */
const THINKING: Readonly<Record<Effort, string>> = { low: "2048", medium: "8192", high: "24576" };

const claudeModels: readonly ModelChoice[] = [
  { id: "claude-opus-5", title: "Opus 5" },
  { id: "claude-sonnet-5", title: "Sonnet 5" },
  { id: "claude-haiku-4-5", title: "Haiku 4.5" },
];

const claudeEnvironment = ({ model, effort }: { model?: string; effort?: Effort }): Record<string, string> => ({
  ...(model ? { ANTHROPIC_MODEL: model } : {}),
  ...(effort ? { MAX_THINKING_TOKENS: THINKING[effort] } : {}),
});

export const harnesses: readonly Harness[] = [
  {
    id: "native",
    title: "Native",
    summary:
      "Our own loop, on OpenRouter. Every control is ours — the prompt, the tools, the context — and a delivery commits with the turn that made it.",
    adapter: "native",
    credential: ["openrouter"],
    models: [
      { id: "deepseek/deepseek-v4-flash", title: "DeepSeek V4 Flash" },
      { id: "anthropic/claude-sonnet-5", title: "Claude Sonnet 5" },
      { id: "openai/gpt-5.6", title: "GPT-5.6" },
      { id: "z-ai/glm-5.3-flash", title: "GLM 5.3 Flash" },
    ],
    defaultModel: "deepseek/deepseek-v4-flash",
    effort: true,
  },
  {
    id: "claude-code",
    title: "Claude Code",
    summary:
      "Claude Code through its SDK, keeping its own system prompt. Its built-in tools are removed and replaced with sandbox-backed ones, so the process runs here and its hands reach only the sandbox.",
    adapter: "sdk",
    credential: ["claude-subscription", "anthropic"],
    models: claudeModels,
    defaultModel: "claude-sonnet-5",
    effort: true,
    environment: claudeEnvironment,
  },
  {
    id: "claude-code-acp",
    title: "Claude Code (in sandbox)",
    summary:
      "The same agent, started inside the sandbox and driven over the protocol. Less control than the SDK — its tools cannot be removed — but the whole process is contained.",
    adapter: "acp",
    credential: ["claude-subscription", "anthropic"],
    command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
    mode: "default",
    // Named nothing on purpose. Asked, this agent answers `sonnet`, `haiku`,
    // `opus[1m]` and a `default` — not the names its SDK takes — along with six
    // reasoning levels where we have three, a fast toggle and a subagent
    // selector. A row that guessed at any of that would be wrong in a way the
    // session could not correct, so the session asks and offers the answer.
    models: [],
    effort: false,
  },
  {
    id: "codex",
    title: "Codex",
    summary: "Codex on a ChatGPT subscription, started inside the sandbox.",
    // The protocol rather than a library: Codex ships nothing equivalent to the
    // Claude Agent SDK that would let its tools be removed, and `codex-acp` is
    // what has been made to start and hand-shake here.
    adapter: "acp",
    credential: ["chatgpt"],
    command: ["npx", "-y", "@agentclientprotocol/codex-acp@1.6.2"],
    // Naming its models would be inventing them. It publishes its own over the
    // protocol; until that list is read and offered, it uses its default.
    models: [],
    effort: false,
  },
  {
    id: "pi",
    title: "Pi",
    summary: "The Pi coding agent, started inside the sandbox.",
    adapter: "acp",
    credential: [],
    command: ["npx", "-y", "pi-acp@0.0.33"],
    models: [],
    effort: false,
    unavailable:
      "Not configured: pointing Pi at OpenRouter from here has not been worked out, so it would run on whatever it is already signed in to.",
  },
  {
    id: "opencode",
    title: "OpenCode",
    summary: "OpenCode, started inside the sandbox.",
    adapter: "acp",
    credential: [],
    command: ["opencode", "acp"],
    models: [],
    effort: false,
    unavailable: "Not configured: the binary is not installed here, and its provider configuration is unverified.",
  },
  {
    id: "cursor",
    title: "Cursor",
    summary: "Cursor's agent on a Cursor subscription, started inside the sandbox.",
    adapter: "acp",
    credential: [],
    command: ["cursor-agent", "acp"],
    models: [],
    effort: false,
    unavailable: "Not configured: the binary is not installed here, and its subscription login is not wired into Settings.",
  },
];

export const harnessFor = (id: HarnessId | undefined): Harness | undefined =>
  harnesses.find((harness) => harness.id === (id ?? "native"));

/** This application's session metadata. aglib stores it and never reads it. */
export type SessionRecord = {
  harness?: HarnessId;
  /** Chosen in the session, and changeable there. */
  model?: string;
  effort?: Effort;
  /**
   * What the agent behind this session said it lets us change, read from it
   * when the session opened.
   *
   * A harness row can only name models for an agent whose models we know. The
   * rest publish their own — including, in the current protocol, a reasoning
   * level — so those lists start empty and fill in from the agent itself. The
   * ids and choices are its vocabulary, recorded rather than translated.
   */
  options?: readonly {
    id: string; name: string; category: string; description?: string;
    current: string | boolean; choices?: readonly { id: string; name: string }[];
  }[];
  /** Chosen among `options`, by the agent's own ids. */
  select?: Readonly<Record<string, string | boolean>>;
  /**
   * Put away, by an operator or by the agent itself when its work is done.
   *
   * Nothing is deleted: the log is the record of what happened and stays whole.
   * This only takes the session out of the list, which is what "finished with
   * this" actually means when a service accumulates hundreds of them.
   */
  archived?: boolean;
  title?: string;
  parentSessionId?: string;
  acpSessionId?: string;
  sandboxId?: string;
};
