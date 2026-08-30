/**
 * Somebody else's whole agent, cheaply.
 *
 * Each row is argv and a credential, because over the Agent Client Protocol
 * that is genuinely all there is to configure. There is no prompt to compose,
 * no tool list to replace and no transcript to seed — a row that offered any of
 * those would be describing a control point this route does not have.
 *
 * That is the trade this recipe exists to make legible. `vendored-agents`
 * spends a vendor dependency and a file per agent to keep the prompt, the tools
 * and the resume. This spends one line and keeps the log, the sandbox and the
 * permission decision. Both are real answers; they are answers to different
 * questions.
 *
 * A row that cannot run says why. An `unavailable` reason is a fact about this
 * repository's setup, not about the agent — leaving the row in with the reason
 * attached is more useful than deleting it, because the next person asks the
 * same question.
 */
export interface AcpAgentRow {
  id: string;
  title: string;
  summary: string;
  /** Argv, run inside the sandbox. */
  command: readonly string[];
  /** The agent's own mode. On Claude, "default" means "ask before acting". */
  mode?: string;
  /** Environment the agent needs to find its provider. Names, not values. */
  credential?: readonly string[];
  /** Why this cannot be started here. */
  unavailable?: string;
}

export const acpAgents: readonly AcpAgentRow[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    summary:
      "The same agent `vendored-agents` drives through its SDK, started inside the sandbox instead. "
      + "Its tools cannot be removed, so the whole process is contained rather than its hands.",
    command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
    mode: "default",
    credential: ["ANTHROPIC_API_KEY"],
  },
  {
    id: "codex",
    title: "Codex",
    summary: "Codex on a ChatGPT subscription. It ships nothing equivalent to an embeddable agent library, so this is the route.",
    command: ["npx", "-y", "@agentclientprotocol/codex-acp@1.6.2"],
    credential: ["OPENAI_API_KEY"],
  },
  {
    id: "opencode",
    title: "OpenCode",
    summary:
      "OpenCode publishes one package and no agent library: its loop is a composition of its own, and its tools are "
      + "reachable only through its plugin boundary. So it belongs here rather than beside Pi.",
    command: ["opencode", "acp"],
    unavailable: "The binary is not installed here, and its provider configuration is unverified.",
  },
  {
    id: "cursor",
    title: "Cursor",
    summary: "Cursor's agent on a Cursor subscription.",
    command: ["cursor-agent", "acp"],
    unavailable: "The binary is not installed here, and its subscription login is not wired up.",
  },
];

export const acpAgentFor = (id: string): AcpAgentRow | undefined => acpAgents.find((agent) => agent.id === id);
