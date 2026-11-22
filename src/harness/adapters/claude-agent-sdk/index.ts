import { createSdkMcpServer, query as sdkQuery, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Harness, HarnessContext, HarnessResult } from "../../harness.js";
import type { Content } from "../../../content.js";
import { textOf } from "../../../content.js";
import type { ToolResult, Usage } from "../../../session/entry.js";
import { addUsage, arrivals, createToolRunner, opening, openingInputs, sessionState } from "../vendor.js";

export interface ClaudeAgentSdkHarnessOptions {
  /** Claude Code's model id or alias. */
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * The Claude Code process's whole environment. It replaces the server's
   * rather than adding to it, so a secret the server holds for something else
   * never reaches the agent process. Put the credential here —
   * `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` for a subscription, or
   * `ANTHROPIC_API_KEY` — with `PATH`, `HOME` and `CLAUDE_CONFIG_DIR`, which is
   * where the process keeps the sessions a later activation resumes.
   */
  env: Readonly<Record<string, string>>;
  /** The process's working directory. It runs no tools of its own, so this only needs to exist. */
  cwd: string;
  /** The `claude` binary, when the SDK's bundled one is not the one to run. */
  executable?: string;
  /** Injectable for tests; the default is the SDK's own. */
  query?: typeof sdkQuery;
}

const provider = "claude-agent-sdk";
const server = "tools";

/**
 * Anthropic's agent loop, running our tools and nothing of its own.
 *
 * The Claude Agent SDK starts the unmodified Claude Code binary, so the
 * credential is whatever that binary accepts: an API key, or the token a
 * subscriber gets from `claude setup-token`. That second one is the reason this
 * adapter exists. A Claude subscription is sold for Claude Code, and the only
 * way to spend one from an agent of your own is to let Claude Code run the loop.
 * See `recipes/subscription-agent` for what that costs.
 *
 * What it keeps: our instructions as the whole system prompt, our tools as the
 * whole tool list (served in-process over MCP, so the model sees them as
 * `mcp__tools__<name>`), every call through our executor and into our log. Its
 * built-in tools are switched off, not merely refused, so nothing runs on the
 * host this process runs on.
 *
 * What it gives up: the context is Claude Code's. It compacts on its own
 * schedule, and an activation interrupted mid-turn is over (`recovery: "none"`);
 * the next one resumes the vendor's session where the log says it was, or, if
 * another model has spoken since, starts a new one from a transcript. Usage is
 * the turn's token counts on its final entry. The SDK also states a cost, which
 * it computes from API list prices whatever the credential is; for a
 * subscription that is not money anyone spent, so it is not recorded.
 */
export function createClaudeAgentSdkHarness(options: ClaudeAgentSdkHarnessOptions): Harness {
  return {
    id: `${provider}:${options.model}`,
    recovery: "none",
    async run(context) {
      const first = await runTurn(options, context, opening(context, provider));
      // A session the log names but the process no longer has — a new machine, a
      // cleared config directory — is a fresh start from the transcript, once.
      if (first.status === "failed" && first.error.code === "session-missing") {
        return runTurn(options, context, opening(context, provider, { fresh: true }));
      }
      return first;
    },
  };
}

async function runTurn(options: ClaudeAgentSdkHarnessOptions, context: HarnessContext, start: { resume?: string; prompt: Content }): Promise<HarnessResult> {
  const runner = createToolRunner(context);
  const shown = openingInputs(context);
  const startedAt = new Date().toISOString();
  const inputs = createInputs();
  const waiting = new Map<string, string[]>();
  const outstanding = new Set<string>();
  let session = start.resume ?? "";
  let served: string | undefined;

  const send = (content: Content) => {
    const uuid = crypto.randomUUID();
    outstanding.add(uuid);
    inputs.push({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: encodeContent(content) } } as SDKUserMessage);
  };

  const tools = (context.tools?.list() ?? []).map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: (z.fromJSONSchema(spec.parameters as never) as z.ZodObject).shape,
    handler: async (args: unknown) => {
      const callId = waiting.get(spec.name)?.shift() ?? `call_${crypto.randomUUID()}`;
      const result = await runner.run({ callId, name: spec.name, arguments: JSON.stringify(args ?? {}) });
      // The boundary the native loop drains at: a batch's results are in, and
      // nothing is half-done. What arrived is queued behind this call's result.
      if (await context.drain?.()) for (const input of arrivals(context, shown)) send(input);
      return encodeResult(result);
    },
  }));

  const abort = new AbortController();
  const cancel = () => abort.abort();
  context.signal.addEventListener("abort", cancel, { once: true });
  send(start.prompt);

  const query = options.query ?? sdkQuery;
  let usage: Usage | undefined;
  // What the process said on its way out: an exit code alone names no reason.
  let stderr = "";
  const said = (message: string) => stderr.trim() ? `${message}: ${stderr.trim().slice(-1_000)}` : message;
  try {
    const messages = query({
      prompt: inputs,
      options: {
        model: options.model,
        ...(options.effort ? { effort: options.effort } : {}),
        systemPrompt: [textOf(context.instructions), ...(context.context?.run ? [context.context.run] : [])],
        tools: [],
        mcpServers: { [server]: createSdkMcpServer({ name: server, version: "1", alwaysLoad: true, tools }) },
        allowedTools: tools.map((tool) => `mcp__${server}__${tool.name}`),
        permissionMode: "dontAsk",
        settingSources: [],
        includePartialMessages: true,
        persistSession: true,
        cwd: options.cwd,
        env: { ...options.env },
        abortController: abort,
        stderr: (data: string) => { stderr = `${stderr}${data}`.slice(-2_000); },
        ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
        ...(start.resume ? { resume: start.resume } : {}),
      },
    });
    for await (const message of messages as AsyncIterable<SDKMessage>) {
      if (message.session_id) session = message.session_id;
      if (message.type === "stream_event") { emitDelta(context, message.event); continue; }
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        served = message.message.model;
        for (const block of message.message.content) {
          if (block.type === "text") runner.say(block.text);
          if (block.type === "tool_use" && block.name.startsWith(`mcp__${server}__`)) {
            const name = block.name.slice(`mcp__${server}__`.length);
            waiting.set(name, [...(waiting.get(name) ?? []), block.id]);
          }
        }
        continue;
      }
      if (message.type !== "result") continue;
      usage = addUsage(usage, decodeUsage(message.usage));
      for (const uuid of [message.user_message_uuid, ...(message.user_message_uuids ?? [])]) if (uuid) outstanding.delete(uuid);
      // A refused request — a bad token, a spent plan — is a "success" that says it is an error.
      if (message.subtype !== "success" || message.is_error) {
        inputs.close();
        const said = message.subtype === "success" ? message.result || "Claude Code reported an error." : message.errors.join("; ") || message.subtype;
        if (start.resume && /no conversation found/i.test(said)) {
          return { status: "failed", error: { code: "session-missing", message: said, retryable: true } };
        }
        return { status: "failed", error: { code: "provider", message: `Claude Code stopped: ${said}`, retryable: false } };
      }
      // A message we queued mid-turn may have been answered in this turn or be
      // the next one's; the turn is over when every one has been consumed.
      if (!outstanding.size) inputs.close();
    }
  } catch (error) {
    inputs.close();
    if (context.signal.aborted) return { status: "cancelled" };
    const message = said(error instanceof Error ? error.message : String(error));
    if (start.resume && /no conversation found/i.test(message)) {
      return { status: "failed", error: { code: "session-missing", message, retryable: true } };
    }
    return { status: "failed", error: { code: "provider", message, retryable: false } };
  } finally {
    context.signal.removeEventListener("abort", cancel);
  }
  if (context.signal.aborted) return { status: "cancelled" };
  if (usage) runner.spent(usage);
  const output = await runner.finish(sessionState(provider, session), {
    id: crypto.randomUUID(), startedAt, ...(served ? { model: served } : {}),
  });
  return { status: "completed", output };
}

function emitDelta(context: HarnessContext, event: unknown): void {
  const delta = (event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } }).delta;
  if ((event as { type?: string }).type !== "content_block_delta" || !delta) return;
  if (delta.type === "text_delta" && delta.text) context.emit({ type: "text.delta", text: delta.text, runId: context.runId });
  if (delta.type === "thinking_delta" && delta.thinking) context.emit({ type: "reasoning.delta", text: delta.thinking, runId: context.runId });
}

/** An input stream the process reads from for as long as the turn lasts. */
function createInputs() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(message: SDKUserMessage) { queue.push(message); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string }; title?: string };

function encodeContent(content: Content): string | Block[] {
  if (typeof content === "string") return content;
  return content.flatMap((part): Block[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "image") return [{ type: "image", source: part.source.kind === "inline" ? { type: "base64", media_type: part.mediaType, data: part.source.data } : { type: "url", url: part.source.url } }];
    if (part.type === "file" && part.mediaType === "application/pdf") return [{ type: "document", source: part.source.kind === "inline" ? { type: "base64", media_type: part.mediaType, data: part.source.data } : { type: "url", url: part.source.url }, ...(part.name ? { title: part.name } : {}) }];
    if (part.type === "file") return [{ type: "text", text: `[file ${part.name ?? ""} ${part.mediaType}]` }];
    return [];
  });
}

type ResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function encodeResult(result: ToolResult): { content: ResultBlock[]; isError?: boolean } {
  const content: ResultBlock[] = typeof result.content === "string"
    ? [{ type: "text", text: result.content }]
    : result.content.flatMap((part): ResultBlock[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "image" && part.source.kind === "inline") return [{ type: "image", data: part.source.data, mimeType: part.mediaType }];
      if (part.type === "image" || part.type === "file") return [{ type: "text", text: `[${part.type} ${part.mediaType}]` }];
      return [];
    });
  return { content: content.length ? content : [{ type: "text", text: "" }], ...(result.isError ? { isError: true } : {}) };
}

function decodeUsage(raw: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): Usage {
  const usage: Usage = {};
  if (typeof raw?.input_tokens === "number") usage.inputTokens = raw.input_tokens;
  if (typeof raw?.output_tokens === "number") usage.outputTokens = raw.output_tokens;
  if (typeof raw?.cache_read_input_tokens === "number") usage.cacheReadTokens = raw.cache_read_input_tokens;
  if (typeof raw?.cache_creation_input_tokens === "number") usage.cacheWriteTokens = raw.cache_creation_input_tokens;
  return usage;
}
