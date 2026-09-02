/**
 * Somebody else's whole agent, cheaply.
 *
 * Each row is argv and a credential, because over the Agent Client Protocol
 * that is genuinely all there is to configure. There is no prompt to compose,
 * no tool list to replace and no transcript to seed — a row that offered any of
 * those would be describing a control point this route does not have.
 *
 * That is the trade this recipe exists to make legible. `vendored-agent`
 * spends a vendor dependency and a file per agent to keep the prompt, the tools
 * and the resume. This spends one line and keeps the log, the sandbox and the
 * permission decision. Both are real answers; they are answers to different
 * questions. OpenCode is the clearest case for this side: it publishes one
 * package and no agent library, so its loop is reachable only as a process.
 *
 * A row is three fields and none of them names an option. There was a `mode`,
 * hardcoding one agent's word for "ask before acting" — but a mode is something
 * the agent publishes like any other option, so `/options` and `--set` reach it
 * through the same generic path and the row does not need to know it exists.
 *
 * A row is three fields and none of them is prose. It had a `title` and a
 * `summary`; the title was a second spelling of the id — the id is what you
 * type at `--harness`, so it is what the list shows — and nothing anywhere read
 * the summary, which is how one of them came to claim Cursor was the only agent
 * here answering `--model` some hours after Claude Code was measured publishing
 * five. An unread string is a comment that cannot be checked.
 *
 * No row says whether it can run here, either. Whether a binary is installed is
 * a fact about a machine, and a machine is not something a source file gets to
 * know — one that hardcoded it was wrong about two of these within a day. A row
 * that cannot start fails when it is started, with the reason the spawn gave,
 * which is both true and current.
 */
export interface AcpAgentRow {
  /** What you type at `--harness`, and what the list shows. */
  id: string;
  /** Argv, run inside the sandbox. */
  command: readonly string[];
  /**
   * Environment the agent needs to find its provider. Names, not values.
   *
   * Names rather than a credential type, because where an agent's requests go
   * is the operator's decision and not this table's. Point `ANTHROPIC_BASE_URL`
   * at any endpoint serving that wire — a provider, a gateway, or a local
   * server of your own — and the agent runs on it without this recipe having to
   * know that is what happened.
   */
  credential?: readonly string[];
}

export const acpAgents: readonly AcpAgentRow[] = [
  {
    id: "claude-code",
    command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
    credential: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
  },
  {
    id: "codex",
    command: ["npx", "-y", "@agentclientprotocol/codex-acp@1.6.2"],
    credential: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  },
  {
    id: "opencode",
    command: ["opencode", "acp"],
  },
  {
    id: "cursor",
    command: ["cursor-agent", "acp"],
  },
];

export const acpAgentFor = (id: string): AcpAgentRow | undefined => acpAgents.find((agent) => agent.id === id);
