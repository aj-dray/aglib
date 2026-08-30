/**
 * Claude Code as a harness, built on the Claude Agent SDK rather than on the
 * protocol adapter.
 *
 * `adapters/acp` is the general adapter: one file, any agent in the ACP
 * registry, at the protocol's lowest common denominator. This is the specific
 * one, and it exists because four things that matter here are not expressible
 * over that protocol:
 *
 *   - Claude Code's prompt is opt-in and composable. `preset` gives its coding
 *     guidance, tone and safety rules; `append` layers this service's
 *     orientation on top. Over ACP there is no system-prompt field at all.
 *   - `settingSources: []` and `strictMcpConfig` mean nothing is read from the
 *     host machine. The protocol adapter loads the operator's own `~/.claude`,
 *     which makes a session depend on whose laptop it started from.
 *   - `disallowedTools: ["Task"]` removes the native subagent tool from the
 *     model's context. Over ACP the best available is refusing the call after
 *     it is made, which costs a turn and still advertises the tool.
 *   - Tools run in this process. No bridge process, no HTTP hop.
 *
 * What it gives up is generality: this drives one agent, and it runs where this
 * process runs. The protocol adapter starts its agent through the sandbox, so
 * for a remote box that is still the one that moves the whole agent.
 *
 * It lives in this recipe rather than in the package for the reason
 * `docs/CODE.md` gives: it needs a vendor dependency, and core depends only on
 * `zod`. This is the adapter that will eventually force a companion package.
 */
import {
  query, createSdkMcpServer, tool,
  type Options, type SDKAssistantMessage, type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Harness, HarnessContext, HarnessResult } from "aglib/harness";
import type { Entry, ToolCall, Usage } from "aglib/session";
import type { Decide } from "aglib";
import { textOf } from "aglib";
import type { Store } from "aglib/store";
import type { Sandbox } from "aglib/sandbox";
import type { Effort } from "./effort.ts";
import { callServiceTool, toolDefinitions, type Running, type ServiceToolDefinition } from "./tools.ts";
import { sandboxToolDefinitions } from "./sandbox-tools.ts";

const budgets: Readonly<Record<Effort, number>> = { low: 2048, medium: 8192, high: 24576 };

/** A content block, read positionally. The SDK's union is richer than the four kinds this maps. */
type Block = { type: string; [key: string]: unknown };

export interface ClaudeCodeHarnessOptions {
  store: Store;
  running: Running;
  sessionId: string;
  sandbox: Sandbox;
  /**
   * Whose hands the agent uses.
   *
   * "own" leaves Claude Code's Read, Write, Edit and Bash in place. They run in
   * this process, so they reach the machine the service runs on — which is only
   * the sandbox when the sandbox is a directory on that same machine.
   *
   * "sandbox" takes every built-in tool away and gives back `bash`,
   * `read_file` and `write_file` backed by the sandbox port. The process still
   * runs here; its hands do not. That is the containment this library is for,
   * and it is why an agent whose own tools cannot be removed has to be started
   * inside the box instead.
   */
  hands: "own" | "sandbox";
  model?: string;
  effort?: Effort;
  /** Applied to Claude's own tools, per call, with the real name and parsed input. */
  decide?: Decide;
  /** Claude's previous session id, so this activation continues its context. */
  resume?: string;
  onSession?(sessionId: string): void;
  env?: Readonly<Record<string, string>>;
  /** Carried into Claude's prompt. This is the shared orientation. */
  instructions?: string;
}

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions): Harness {
  return {
    id: "claude-code",
    // Its tools are its own: we choose which exist and decide each call, but we
    // never validated arguments against a schema we wrote.
    recovery: "none",
    run: (context) => runTurn(options, context),
  };
}

async function runTurn(options: ClaudeCodeHarnessOptions, context: HarnessContext): Promise<HarnessResult> {
  // Keeping its own tools while the sandbox is elsewhere would put its hands on
  // this machine and call it contained. Refused rather than run.
  if (options.hands === "own" && options.sandbox.isolation !== "none") {
    return {
      status: "failed",
      error: {
        code: "unsupported",
        message:
          `This harness runs in the service's own process, so its built-in tools reach this machine, not the ` +
          `${options.sandbox.isolation}. Use hands: "sandbox" to replace them with sandbox-backed tools.`,
        retryable: false,
      },
    };
  }
  let output = "";
  let failure: string | undefined;

  const running = query({
    // An async iterable rather than a string: control requests — interrupt,
    // and the SDK's own message priorities — work only in streaming input mode.
    prompt: (async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: inputFor(context) },
        parent_tool_use_id: null,
        session_id: options.resume ?? "",
      };
    })(),
    options: optionsFor(options, context),
  });

  // Which API responses have already been counted. Several assistant messages
  // can carry one response's usage — see `receive`.
  const counted = new Set<string>();

  const stop = () => { void running.interrupt(); };
  context.signal.addEventListener("abort", stop, { once: true });

  try {
    for await (const message of running) {
      const committed = await receive(message, options, context, counted);
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

function optionsFor(options: ClaudeCodeHarnessOptions, context: HarnessContext): Options {
  const orientation = options.instructions ?? textOf(context.instructions);
  const contained = options.hands === "sandbox";

  const ours: readonly ServiceToolDefinition[] = [
    ...toolDefinitions({ store: options.store, sessionId: options.sessionId, running: options.running }),
    ...(contained ? sandboxToolDefinitions(options.sandbox) : []),
  ];

  return {
    // Where the process sits. With sandbox hands nothing of the agent's reads
    // it, because it has no tool that can.
    cwd: contained ? process.cwd() : options.sandbox.root,

    // Claude Code's own prompt with ours after it. Its row says this harness is
    // Claude Code, so replacing that prompt would make the name a lie; a bare
    // one is a different harness, not a setting on this one.
    systemPrompt: { type: "preset", preset: "claude_code", append: orientation },

    // Nothing from the host machine: no user or project settings, no CLAUDE.md,
    // no `.mcp.json`, no installed plugins. A session must not depend on whose
    // machine the service happens to run on.
    settingSources: [],
    strictMcpConfig: true,

    // With sandbox hands, every built-in goes: `tools: []` is default-deny, so
    // a tool added by a future version cannot quietly reach this machine.
    // Otherwise only the subagent tool goes, removed from the model's context
    // rather than refused after the fact, so it never sees an option it cannot
    // take.
    ...(contained ? { tools: [] } : { disallowedTools: ["Task"] }),

    mcpServers: {
      "agent-service": createSdkMcpServer({
        name: "agent-service",
        version: "0",
        tools: ours
          .map((definition) =>
            tool(definition.name, definition.description, definition.schema.shape, async (args) => {
              const answered = await callServiceTool({
                store: options.store,
                running: options.running,
                sessionId: options.sessionId,
                tools: ours,
                name: definition.name,
                arguments: args as never,
              });
              return { content: [{ type: "text" as const, text: answered.content }], isError: answered.isError };
            })),
      }),
    },

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
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.env ? { env: options.env as Record<string, string> } : {}),
  };
}

/**
 * One SDK message becomes entries.
 *
 * The fidelity here is the second reason this adapter exists: content blocks
 * arrive typed, so a tool call carries its real name and its real arguments,
 * and usage carries the token split and the cost. The protocol adapter has to
 * reconstruct all of that from update notifications.
 */
async function receive(
  message: SDKMessage,
  options: ClaudeCodeHarnessOptions,
  context: HarnessContext,
  counted: Set<string>,
): Promise<{ output?: string; failure?: string }> {
  if (message.type === "system" && message.subtype === "init") {
    options.onSession?.(message.session_id);
    return {};
  }

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
    if (message.subtype !== "success") {
      return { failure: `Claude Code stopped: ${message.subtype}.` };
    }
    // The SDK's own total is deliberately not reported here. It would be a
    // second answer to what the assistant entries above already say, and the
    // one that disappears when a run is cancelled before its result arrives.
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
 * Two things about this SDK decide the shape, both documented by it:
 *
 * A response that used several tools arrives as **several assistant messages
 * sharing one `id`**, each repeating that response's usage. Counting them all
 * inflates input and cache tokens by however many tools the model reached for,
 * so a response is counted the first time its id is seen.
 *
 * Per-message `output_tokens` is **a placeholder** — the count the API had
 * reported when the response began, before it was generated — and the real
 * total arrives only on the SDK's own terminal result. So it is not recorded.
 * An absent count is not a zero: a deployment pricing this harness sees a
 * generation it cannot price, which under a `maxUsd` ceiling stops the run
 * rather than billing it short. Recording the placeholder as a fact would be
 * the same error with none of the warning.
 *
 * Subagent messages carry their own `parent_tool_use_id` and are left to the
 * turn that spawned them.
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
