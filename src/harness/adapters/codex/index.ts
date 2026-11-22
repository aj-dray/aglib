import { spawn } from "node:child_process";
import type { Harness, HarnessContext, HarnessResult } from "../../harness.js";
import type { Content } from "../../../content.js";
import { textOf } from "../../../content.js";
import type { ToolResult, Usage } from "../../../session/entry.js";
import { err, ok, type Failure, type Result } from "../../../result.js";
import type { JsonValue } from "../../../json.js";
import { arrivals, createToolRunner, described, opening, openingInputs, sessionState, toolFingerprint } from "../vendor.js";

/** How to start Codex's app server: argv and its whole environment. */
export interface CodexProcess {
  /** Defaults to `["codex", "app-server"]`. */
  command?: readonly string[];
  /**
   * The process's whole environment, which replaces the server's. `CODEX_HOME`
   * is where Codex keeps its sign-in and the threads a later activation
   * resumes; `PATH` and `HOME` it needs as any program does.
   */
  env: Readonly<Record<string, string>>;
  /** Further `-c key=value` overrides, the value in TOML. */
  config?: Readonly<Record<string, string>>;
  /** Injectable for tests; the default spawns `command`. */
  connect?: (argv: readonly string[], env: Readonly<Record<string, string>>) => CodexConnection;
}

export interface CodexHarnessOptions extends CodexProcess {
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The thread's working directory. Codex runs no tools of its own here, so this only needs to exist. */
  cwd: string;
}

/** One JSON-RPC peer over newline-delimited JSON. */
export interface CodexConnection {
  send(message: JsonValue): void;
  readonly messages: AsyncIterable<JsonValue>;
  close(): void;
}

const provider = "codex-app-server";

/**
 * Codex's own built-in tools, switched off by name.
 *
 * Every one of them would run on the host this process runs on, which is the
 * application's server rather than any sandbox of ours, so none may stay on.
 * The names are Codex's feature flags as of the version this was measured
 * against; a feature it adds later is caught at run time instead — any item
 * that is not one of our calls fails the turn (`ownItems`).
 */
const disabled = [
  "shell_tool", "unified_exec", "view_image", "multi_agent", "goals", "apps", "image_generation",
  "computer_use", "browser_use", "skill_search", "tool_suggest", "sleep_tool", "code_mode_host", "auth_elicitation",
];
const settings: Readonly<Record<string, string>> = {
  web_search: '"disabled"',
  "skills.include_instructions": "false",
  "tools.experimental_request_user_input.enabled": "false",
};
/** Thread items that mean Codex did something itself. */
const ownItems = new Set(["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "imageGeneration"]);

/**
 * OpenAI's Codex loop, running our tools and nothing of its own.
 *
 * Codex is the program a ChatGPT plan is sold for, and its app server is the
 * protocol its own clients speak, so this is how a subscriber spends their plan
 * from an agent of their own: sign Codex in (`signInToCodex`), and let it run
 * the loop. An API key works the same way, through Codex's own configuration.
 *
 * What it keeps: our instructions as the thread's base instructions, our tools
 * as its whole tool list (declared as dynamic tools, which Codex calls back for
 * rather than running), every call through our executor and into our log. What
 * it gives up is what `createClaudeAgentSdkHarness` gives up: the context is
 * Codex's and is compacted by Codex, an interrupted activation is over, and a
 * later one resumes the thread the log names or starts a new one from a
 * transcript. Codex fixes a thread's tools when it starts, so a thread is
 * resumed only while the tool list is the one it was started with.
 */
export function createCodexHarness(options: CodexHarnessOptions): Harness {
  return {
    id: `${provider}:${options.model}`,
    recovery: "none",
    async run(context) {
      const fingerprint = toolFingerprint(context);
      const first = await runTurn(options, context, opening(context, provider, { fingerprint }), fingerprint);
      if (first.status === "failed" && first.error.code === "session-missing") {
        return runTurn(options, context, opening(context, provider, { fresh: true, fingerprint }), fingerprint);
      }
      return first;
    },
  };
}

async function runTurn(options: CodexHarnessOptions, context: HarnessContext, start: { resume?: string; prompt: Content }, fingerprint: string): Promise<HarnessResult> {
  const rpc = open(options);
  const runner = createToolRunner(context);
  const shown = openingInputs(context);
  const startedAt = new Date().toISOString();
  let usage: Usage | undefined;
  let turnId: string | undefined;
  let threadId = start.resume ?? "";
  let finished: ((result: HarnessResult) => void) | undefined;
  const done = new Promise<HarnessResult>((resolve) => { finished = resolve; });
  const fail = (code: string, message: string) => finished?.({ status: "failed", error: { code, message, retryable: false } });

  rpc.onRequest("item/tool/call", async (params) => {
    const name = String(field(params, "tool") ?? "");
    const callId = String(field(params, "callId") ?? `call_${crypto.randomUUID()}`);
    const result = await runner.run({ callId, name, arguments: JSON.stringify(field(params, "arguments") ?? {}) });
    // Our boundary for `turn` input, as in the native loop: results are in.
    if (await context.drain?.() && turnId) {
      for (const input of arrivals(context, shown)) {
        void rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: encodeInput(input) });
      }
    }
    return ok(encodeResult(result));
  });
  // Nothing of Codex's own runs, so nothing of its own is approved or answered.
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"]) {
    rpc.onRequest(method, async () => ok({ decision: "decline" }));
  }
  rpc.onRequest("item/tool/requestUserInput", async () => ok({ answers: {} }));
  rpc.onRequest("mcpServer/elicitation/request", async () => ok({ action: "decline", content: null, _meta: null }));

  rpc.onNotify("item/agentMessage/delta", (params) => context.emit({ type: "text.delta", text: String(field(params, "delta") ?? ""), runId: context.runId }));
  rpc.onNotify("item/reasoning/textDelta", (params) => context.emit({ type: "reasoning.delta", text: String(field(params, "delta") ?? ""), runId: context.runId }));
  rpc.onNotify("item/started", (params) => {
    const type = String(field(field(params, "item"), "type") ?? "");
    if (ownItems.has(type)) {
      void rpc.request("turn/interrupt", { threadId, turnId: String(field(params, "turnId") ?? turnId ?? "") });
      fail("unsupported", `Codex started a ${type} of its own, which this harness does not allow. Its built-in tools are disabled by name; this Codex has one the list does not know.`);
    }
  });
  rpc.onNotify("item/completed", (params) => {
    const item = field(params, "item");
    if (field(item, "type") === "agentMessage") runner.say(String(field(item, "text") ?? ""));
  });
  let baseline: Counts | undefined;
  rpc.onNotify("thread/tokenUsage/updated", (params) => {
    if (field(params, "turnId") !== turnId) return;
    const total = counts(field(field(params, "tokenUsage"), "total"));
    baseline ??= minus(total, counts(field(field(params, "tokenUsage"), "last")));
    usage = decodeUsage(minus(total, baseline));
  });
  rpc.onNotify("turn/completed", (params) => {
    const turn = field(params, "turn");
    if (turnId && field(turn, "id") !== turnId) return;
    const status = String(field(turn, "status") ?? "");
    if (status === "completed") finished?.({ status: "completed", output: "" });
    else if (status === "interrupted") finished?.({ status: "cancelled" });
    else fail("provider", `Codex stopped: ${String(field(field(turn, "error"), "message") ?? status)}`);
  });
  rpc.onClose((reason) => fail("provider", `Codex exited: ${reason}`));

  const cancel = () => {
    if (turnId) void rpc.request("turn/interrupt", { threadId, turnId });
    finished?.({ status: "cancelled" });
  };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    const ready = await initialize(rpc);
    if (!ready.ok) return { status: "failed", error: ready.error };

    const thread = {
      model: options.model, cwd: options.cwd, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: [textOf(context.instructions), ...(context.context?.run ? [context.context.run] : [])].join("\n\n"),
    };
    const opened = start.resume
      ? await rpc.request("thread/resume", { ...thread, threadId: start.resume })
      : await rpc.request("thread/start", { ...thread, dynamicTools: (context.tools?.list() ?? []).map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters })) } as JsonValue);
    if (!opened.ok) {
      if (start.resume) return { status: "failed", error: { code: "session-missing", message: opened.error.message, retryable: true } };
      return { status: "failed", error: opened.error };
    }
    threadId = String(field(field(opened.value, "thread"), "id") ?? threadId);

    const turned = await rpc.request("turn/start", { threadId, input: encodeInput(start.prompt), ...(options.effort ? { effort: options.effort } : {}) } as JsonValue);
    if (!turned.ok) return { status: "failed", error: turned.error };
    turnId = String(field(field(turned.value, "turn"), "id") ?? "");

    const ended = await done;
    if (ended.status !== "completed") return ended;
    if (usage) runner.spent(usage);
    const output = await runner.finish(sessionState(provider, threadId, fingerprint), { id: turnId, startedAt, model: options.model });
    return { status: "completed", output };
  } finally {
    context.signal.removeEventListener("abort", cancel);
    rpc.close();
  }
}

/** Whether Codex is signed in, and as whom. */
export async function codexAccount(process_: CodexProcess): Promise<Result<{ signedIn: false } | { signedIn: true; kind: string; email?: string; plan?: string }, Failure>> {
  const rpc = open(process_);
  try {
    const ready = await initialize(rpc);
    if (!ready.ok) return ready;
    const read = await rpc.request("account/read", {});
    if (!read.ok) return read;
    const account = field(read.value, "account");
    if (!account) return ok({ signedIn: false });
    const email = field(account, "email"), plan = field(account, "planType");
    return ok({ signedIn: true, kind: String(field(account, "type") ?? ""), ...(typeof email === "string" ? { email } : {}), ...(typeof plan === "string" ? { plan } : {}) });
  } finally {
    rpc.close();
  }
}

/**
 * Sign Codex in to a ChatGPT plan with a device code: the person opens
 * `verificationUrl`, signs in to OpenAI there, and enters `userCode`.
 *
 * OpenAI's own flow, run by Codex itself, so no credential passes through the
 * caller; Codex keeps the grant in `CODEX_HOME` and refreshes it. The process
 * stays up until `completed` settles or `cancel` is called.
 */
export async function signInToCodex(process_: CodexProcess): Promise<Result<{ verificationUrl: string; userCode: string; completed: Promise<Result<void, Failure>>; cancel(): void }, Failure>> {
  const rpc = open(process_);
  const ready = await initialize(rpc);
  if (!ready.ok) { rpc.close(); return ready; }
  let settle!: (result: Result<void, Failure>) => void;
  const completed = new Promise<Result<void, Failure>>((resolve) => { settle = resolve; });
  rpc.onNotify("account/login/completed", (params) => {
    settle(field(params, "success") === true ? ok(undefined) : err({ code: "auth", message: String(field(params, "error") ?? "Sign-in did not complete."), retryable: true }));
  });
  rpc.onClose((reason) => settle(err({ code: "provider", message: `Codex exited: ${reason}`, retryable: true })));
  const started = await rpc.request("account/login/start", { type: "chatgptDeviceCode" });
  if (!started.ok) { rpc.close(); return started; }
  const loginId = String(field(started.value, "loginId") ?? "");
  void completed.finally(() => rpc.close());
  return ok({
    verificationUrl: String(field(started.value, "verificationUrl") ?? ""),
    userCode: String(field(started.value, "userCode") ?? ""),
    completed,
    cancel() { void rpc.request("account/login/cancel", { loginId }).finally(() => settle(err({ code: "cancelled", message: "Sign-in cancelled.", retryable: false }))); },
  });
}

const initialize = async (rpc: ReturnType<typeof open>) => {
  // Dynamic tools are an experimental field, and Codex leaves them out unless asked.
  const ready = await rpc.request("initialize", { clientInfo: { name: "aglib", title: null, version: "0" }, capabilities: { experimentalApi: true } });
  if (ready.ok) rpc.notify("initialized");
  return ready;
};

/** A JSON-RPC client over one connection, answering the server's requests from handlers. */
function open(process_: CodexProcess) {
  const argv = [...(process_.command ?? ["codex", "app-server"])];
  for (const feature of disabled) argv.push("--disable", feature);
  for (const [key, value] of Object.entries({ ...settings, ...process_.config })) argv.push("-c", `${key}=${value}`);
  const connection = (process_.connect ?? spawnConnection)(argv, process_.env);
  const pending = new Map<number, (result: Result<JsonValue, Failure>) => void>();
  const requests = new Map<string, (params: JsonValue | undefined) => Promise<Result<JsonValue, Failure>>>();
  const notices = new Map<string, (params: JsonValue | undefined) => void>();
  const closers: ((reason: string) => void)[] = [];
  let next = 0;
  let closed = false;

  void (async () => {
    let reason = "its output ended";
    try {
      for await (const message of connection.messages) {
        const id = field(message, "id");
        const method = field(message, "method");
        if (typeof method !== "string") {
          const reply = pending.get(Number(id));
          pending.delete(Number(id));
          const error = field(message, "error");
          reply?.(error ? err({ code: "protocol", message: String(field(error, "message") ?? "Codex refused the request."), retryable: false }) : ok(field(message, "result") ?? null));
          continue;
        }
        if (id === undefined) { notices.get(method)?.(field(message, "params")); continue; }
        // Answered without holding up the reader: a tool call can take minutes,
        // and the notifications and replies behind it still need reading.
        const handler = requests.get(method);
        void (handler ? handler(field(message, "params")) : Promise.resolve(err<Failure>({ code: "unsupported", message: `No handler for ${method}.`, retryable: false })))
          .then((answered) => { if (!closed) connection.send(answered.ok ? { id, result: answered.value } : { id, error: { code: -32601, message: answered.error.message } }); });
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (closed) return;
    closed = true;
    for (const reply of pending.values()) reply(err({ code: "provider", message: `Codex exited: ${reason}`, retryable: true }));
    pending.clear();
    for (const close of closers) close(reason);
  })();

  return {
    request(method: string, params: JsonValue): Promise<Result<JsonValue, Failure>> {
      if (closed) return Promise.resolve(err({ code: "provider", message: "Codex is not running.", retryable: true }));
      next += 1;
      const id = next;
      return new Promise((resolve) => { pending.set(id, resolve); connection.send({ id, method, params }); });
    },
    notify(method: string) { connection.send({ method }); },
    onRequest(method: string, handler: (params: JsonValue | undefined) => Promise<Result<JsonValue, Failure>>) { requests.set(method, handler); },
    onNotify(method: string, handler: (params: JsonValue | undefined) => void) { notices.set(method, handler); },
    onClose(handler: (reason: string) => void) { closers.push(handler); },
    close() { if (!closed) { closed = true; connection.close(); } },
  };
}

function spawnConnection(argv: readonly string[], env: Readonly<Record<string, string>>): CodexConnection {
  const child = spawn(argv[0]!, argv.slice(1), { env: { ...env }, stdio: ["pipe", "pipe", "ignore"] });
  const spawned = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return {
    send(message) { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`); },
    messages: (async function* () {
      await spawned;
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += String(chunk);
        for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          if (!line) continue;
          try { yield JSON.parse(line) as JsonValue; } catch { /* a log line on stdout is not a message */ }
        }
      }
    })(),
    close() { child.stdin.end(); child.kill(); },
  };
}

function encodeInput(content: Content): JsonValue[] {
  if (typeof content === "string") return [{ type: "text", text: content, text_elements: [] }];
  const out: JsonValue[] = [];
  for (const part of content) {
    if (part.type === "image") out.push({ type: "image", url: part.source.kind === "inline" ? `data:${part.mediaType};base64,${part.source.data}` : part.source.url });
    else if (part.type === "text" || part.type === "file") out.push({ type: "text", text: described([part]), text_elements: [] });
  }
  return out;
}

function encodeResult(result: ToolResult): JsonValue {
  const items: JsonValue[] = typeof result.content === "string"
    ? [{ type: "inputText", text: result.content }]
    : result.content.flatMap((part): JsonValue[] => {
      if (part.type === "image") return [{ type: "inputImage", imageUrl: part.source.kind === "inline" ? `data:${part.mediaType};base64,${part.source.data}` : part.source.url }];
      if (part.type === "text" || part.type === "file") return [{ type: "inputText", text: described([part]) }];
      return [];
    });
  return { contentItems: items.length ? items : [{ type: "inputText", text: "" }], success: !result.isError };
}

/**
 * Codex reports the thread's running total and the last request's counts, once
 * per request. The turn's spend is the total now less the total before its
 * first request, which stays right if an update is repeated or one is missed.
 */
type Counts = { input: number; cached: number; written: number; output: number };

function counts(value: JsonValue | undefined): Counts {
  const number = (key: string) => { const found = field(value, key); return typeof found === "number" ? found : 0; };
  return { input: number("inputTokens"), cached: number("cachedInputTokens"), written: number("cacheWriteInputTokens"), output: number("outputTokens") };
}

const minus = (a: Counts, b: Counts): Counts => ({ input: a.input - b.input, cached: a.cached - b.cached, written: a.written - b.written, output: a.output - b.output });

/** OpenAI counts cached input inside `inputTokens`; `Usage` keeps the three disjoint. */
function decodeUsage(turn: Counts): Usage {
  return {
    inputTokens: Math.max(0, turn.input - turn.cached - turn.written),
    outputTokens: turn.output,
    cacheReadTokens: turn.cached,
    ...(turn.written ? { cacheWriteTokens: turn.written } : {}),
  };
}

const field = (value: JsonValue | undefined, key: string): JsonValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>)[key] : undefined;
