/**
 * Claude Code as a `Harness`, on the SDK rather than the protocol.
 *
 * `adapters/acp` is the general adapter: one file, any agent in the registry,
 * at the protocol's lowest common denominator. This is the specific one, and it
 * exists because four things that matter are not expressible over that wire:
 *
 *   - Its prompt is opt-in and composable. `preset` gives its coding guidance,
 *     tone and safety rules; `append` layers ours on top. ACP has no
 *     system-prompt field at all.
 *   - `settingSources: []` and `strictMcpConfig` mean nothing is read from the
 *     host machine. The protocol adapter loads the operator's own `~/.claude`,
 *     which makes a session depend on whose laptop it started from.
 *   - `disallowedTools: ["Task"]` removes the subagent tool from the model's
 *     context. Over ACP the best available is refusing the call after it is
 *     made, which costs a turn and still advertises the tool.
 *   - Tools run in this process. No bridge, no HTTP hop.
 *
 * What it gives up is generality: this drives one agent, and it runs where this
 * process runs.
 *
 * It lives in a recipe rather than the package for the reason `docs/CODE.md`
 * gives — it needs a vendor dependency, and core depends only on `zod`. The
 * wire translation that lets it run on a non-Anthropic model does *not* need
 * one, which is why that half is in `aglib/model/anthropic-wire` and only the
 * socket is here.
 */
import {
  query, createSdkMcpServer, tool,
  type Options, type SDKAssistantMessage, type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Harness, HarnessContext, HarnessResult } from "aglib/harness";
import type { Entry, ToolCall, Usage } from "aglib/session";
import type { Decide } from "aglib";
import { textOf } from "aglib";
import type { Sandbox } from "aglib/sandbox";
import { sandboxToolDefinitions, type ToolDefinition } from "./tools.ts";

/**
 * The built-in tools "theirs" keeps.
 *
 * Named rather than taken wholesale: this is the set that edits and searches
 * files, which is what a coding agent is worth reusing for. `Task` is left out
 * deliberately — a subagent it spawns is one this log never sees.
 */
const builtIns = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/** Its thinking budget, by our three levels. */
const budgets: Readonly<Record<"low" | "medium" | "high", number>> = { low: 2048, medium: 8192, high: 24576 };

/** A content block, read positionally. The SDK's union is richer than the kinds this maps. */
type Block = { type: string; [key: string]: unknown };

export interface ClaudeCodeOptions {
  sandbox: Sandbox;
  /**
   * Whose tools the agent gets, and it may be both.
   *
   * "ours" takes every built-in away — `tools: []` is default-deny, so one
   * added by a future version cannot quietly reach this machine — and gives
   * back `bash`, `read_file` and `write_file` through the sandbox port. The
   * process still runs here; its hands do not.
   *
   * "theirs" leaves Read, Write, Edit and Bash in place. They are *inside* the
   * agent, not values we can take, so they run in this process and reach this
   * machine. Unlike Pi's, they cannot be re-pointed at a sandbox.
   *
   * "both" is the interesting one and the reason this is not a boolean: keep
   * their editing tools, which are good, and add ours beside them — a memory,
   * a delegation, whatever this application is actually for.
   *
   * Anything but "ours" therefore requires a sandbox that *is* this machine.
   * Asking for a container while their tools are in place would be calling
   * something contained that is not.
   */
  tools: "ours" | "theirs" | "both";
  model?: string;
  effort?: "low" | "medium" | "high";
  /** Applied to Claude's own tools, per call, with the real name and parsed input. */
  decide?: Decide;
  /** Non-secret configuration for the agent process — where its model lives, most of all. */
  env?: Readonly<Record<string, string>>;
}

export function createClaudeCodeHarness(options: ClaudeCodeOptions): Harness {
  return {
    id: "claude-code",
    // The agent owns its context. Our entries describe what it did and cannot
    // by themselves put it back mid-turn.
    recovery: "none",
    run: (context) => runTurn(options, context),
  };
}

async function runTurn(options: ClaudeCodeOptions, context: HarnessContext): Promise<HarnessResult> {
  // Keeping its own tools while the sandbox is elsewhere would put its hands on
  // this machine and call it contained. Refused rather than run.
  if (options.tools !== "ours" && options.sandbox.isolation !== "none") {
    return {
      status: "failed",
      error: {
        code: "unsupported",
        message:
          "This harness runs in our own process, so its built-in tools reach this machine, not the "
          + `${options.sandbox.isolation}. Use tools: "ours" to replace them with sandbox-backed ones.`,
        retryable: false,
      },
    };
  }

  let output = "";
  let failure: string | undefined;

  const running = query({
    prompt: (async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: inputFor(context) },
        parent_tool_use_id: null,
        session_id: "",
      };
    })(),
    options: optionsFor(options, context),
  });

  // Which API responses have already been counted — see `spentOn`.
  const counted = new Set<string>();
  const stop = () => { void running.interrupt(); };
  context.signal.addEventListener("abort", stop, { once: true });

  try {
    for await (const message of running) {
      const committed = await receive(message, context, counted);
      if (committed.output !== undefined) output = committed.output;
      if (committed.failure) failure = committed.failure;
    }
  } catch (error) {
    if (context.signal.aborted) return { status: "cancelled" };
    return {
      status: "failed",
      error: { code: "failed", message: error instanceof Error ? error.message : String(error), retryable: true },
    };
  } finally {
    context.signal.removeEventListener("abort", stop);
  }

  if (context.signal.aborted) return { status: "cancelled" };
  if (failure) return { status: "failed", error: { code: "failed", message: failure, retryable: true } };
  return { status: "completed", output };
}

function optionsFor(options: ClaudeCodeOptions, context: HarnessContext): Options {
  const theirs = options.tools !== "ours";
  const ours: readonly ToolDefinition[] = options.tools === "theirs" ? [] : sandboxToolDefinitions(options.sandbox);

  return {
    // Where the process sits. With sandbox hands nothing of the agent's reads
    // it, because it has no tool that can.
    cwd: theirs ? options.sandbox.root : process.cwd(),

    // Its own prompt with ours after it. This harness *is* Claude Code, so
    // replacing that prompt would make the name a lie; a bare one is a
    // different harness, not a setting on this one.
    systemPrompt: { type: "preset", preset: "claude_code", append: textOf(context.instructions) },

    // Nothing from the host machine: no user or project settings, no CLAUDE.md,
    // no `.mcp.json`, no installed plugins. A session must not depend on whose
    // machine it started from.
    settingSources: [],
    strictMcpConfig: true,

    // Without their tools, `tools: []` is default-deny, so one added by a
    // future version cannot quietly reach this machine. With them, only the
    // subagent tool goes — removed from the model's context rather than refused
    // after the fact, so it never sees an option it cannot take.
    ...(theirs ? { disallowedTools: ["Task"] } : { tools: [] }),

    // Everything it may use, named. Left unset, an MCP tool waits on an
    // approval prompt nobody is at, and the model is told it may not use the
    // only hands it has. Naming them is not a weaker gate: `decide` still runs
    // per call, and it runs on their tools too.
    allowedTools: [
      ...(theirs ? builtIns : []),
      ...ours.map((definition) => `mcp__sandbox__${definition.name}`),
    ],

    ...(ours.length
      ? {
          mcpServers: {
            sandbox: createSdkMcpServer({
              name: "sandbox",
              version: "0",
              tools: ours.map((definition) =>
                tool(definition.name, definition.description, definition.schema.shape, async (args) => {
                  const answered = await definition.execute(args as never, {
                    sessionId: context.sessionId,
                    runId: context.runId,
                    callId: "",
                    signal: context.signal,
                    enqueue: () => {},
                    report: () => {},
                  });
                  return {
                    content: [{ type: "text" as const, text: textOf(answered.content) }],
                    isError: answered.isError,
                  };
                })),
            }),
          },
        }
      : {}),

    ...(options.decide
      ? {
          canUseTool: async (toolName, input) => {
            const decided = await options.decide!({
              // The protocol adapter has to invent a spec here. The SDK gives
              // the real name and the parsed input, so this one does not.
              tool: { name: toolName, description: "", parameters: {} },
              input: input as never,
              sessionId: context.sessionId,
              runId: context.runId,
              callId: "",
            });
            return decided.action === "execute"
              ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: decided.message };
          },
        }
      : {}),

    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { thinking: { type: "enabled" as const, budgetTokens: budgets[options.effort] } } : {}),
    ...(options.env ? { env: options.env as Record<string, string> } : {}),
  };
}

/**
 * One SDK message becomes entries.
 *
 * The fidelity here is the second reason this adapter exists: blocks arrive
 * typed, so a tool call carries its real name and its real arguments, and usage
 * carries the token split. The protocol adapter reconstructs all of that from
 * update notifications.
 */
async function receive(
  message: SDKMessage,
  context: HarnessContext,
  counted: Set<string>,
): Promise<{ output?: string; failure?: string }> {
  if (message.type === "assistant") {
    const blocks = message.message.content as unknown as readonly Block[];
    const said = blocks.filter((block) => block.type === "text").map((block) => String(block["text"] ?? "")).join("");
    const calls: ToolCall[] = blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        callId: String(block["id"] ?? ""),
        name: String(block["name"] ?? ""),
        arguments: JSON.stringify(block["input"] ?? {}),
      }));
    if (said) context.emit({ type: "text.delta", text: said });
    if (!said && !calls.length) return {};
    const spent = spentOn(message, counted);
    await context.commit([{
      type: "assistant", runId: context.runId, content: said,
      ...(calls.length ? { calls } : {}),
      ...(spent ? { usage: spent } : {}),
    }]);
    return { output: said || undefined };
  }

  if (message.type === "user") {
    const raw = message.message.content;
    if (typeof raw === "string") return {};
    const entries: Entry[] = [];
    for (const block of raw as unknown as readonly Block[]) {
      if (block.type !== "tool_result") continue;
      const inner = block["content"];
      const body = typeof inner === "string"
        ? inner
        : (Array.isArray(inner) ? inner : [])
            .map((part) => {
              const piece = part as { type?: string; text?: string };
              return piece.type === "text" ? String(piece.text ?? "") : `[${String(piece.type)}]`;
            })
            .join("\n");
      const callId = String(block["tool_use_id"] ?? "");
      entries.push(
        { type: "tool.started", runId: context.runId, callId },
        {
          type: "tool.finished", runId: context.runId, callId,
          result: { content: body, ...(block["is_error"] ? { isError: true } : {}) },
        },
      );
    }
    if (entries.length) await context.commit(entries);
    return {};
  }

  if (message.type === "result") {
    if (message.subtype !== "success") return { failure: `Claude Code stopped: ${message.subtype}.` };
    // The SDK's own total is deliberately not reported. It would be a second
    // answer to what the assistant entries already say, and the one that
    // disappears when a run is cancelled before its result arrives.
    return { output: message.result };
  }

  return {};
}

interface ApiUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * What one API response consumed, counted once, and only what is real.
 *
 * A response that used several tools arrives as **several assistant messages
 * sharing one `id`**, each repeating that response's usage; counting them all
 * inflates input and cache tokens by however many tools were reached for. And
 * per-message `output_tokens` is a **placeholder** — the count the API had when
 * the response began — so it is not recorded. An absent count is not a zero.
 */
function spentOn(message: SDKAssistantMessage, counted: Set<string>): Usage | undefined {
  if (message.parent_tool_use_id) return undefined;
  const id = message.message.id;
  if (typeof id !== "string" || counted.has(id)) return undefined;
  counted.add(id);
  const reported = message.message.usage as ApiUsage | undefined;
  if (!reported) return undefined;
  const spent: Usage = {
    ...(reported.input_tokens !== undefined ? { inputTokens: reported.input_tokens } : {}),
    ...(reported.cache_read_input_tokens ? { cacheReadTokens: reported.cache_read_input_tokens } : {}),
    ...(reported.cache_creation_input_tokens ? { cacheWriteTokens: reported.cache_creation_input_tokens } : {}),
  };
  return Object.keys(spent).length ? spent : undefined;
}

/** This activation's input: the entries `runAgent` committed before calling us. */
const inputFor = (context: HarnessContext): string =>
  context.entries()
    .filter((entry) => entry.type === "run.started" && entry.runId === context.runId)
    .map((entry) => textOf((entry as Extract<Entry, { type: "run.started" }>).input))
    .join("\n\n");
