import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import type {
  Message, Model, ModelDelta, ModelError, ModelGeneration, ModelRequest,
  ModelResponse, ModelSteerResult, ToolCall, ToolSpec, Usage,
} from "../../model.js";
import type { Content } from "../../../content.js";
import type { JsonValue } from "../../../json.js";
import { err, ok, type Result } from "../../../result.js";

const provider = "openai-responses";
const maxActiveResponses = 16;
const maxStreamIds = 32;

interface StreamEnvelope {
  type: string;
  message?: unknown;
  error?: unknown;
  code?: number;
  reason?: string;
}

/** The small part of ResponsesWS used here, injectable so the wire can be tested without a model call. */
export interface OpenAiResponsesConnection {
  send(event: unknown): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<StreamEnvelope>;
}

export interface OpenAiResponsesOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  headers?: Readonly<Record<string, string>>;
  /** Declare function tools with OpenAI's asynchronous execution extension. */
  asyncTools?: boolean;
  /** Expose mid-generation steering. The provider remains the capability authority. */
  steering?: boolean;
  /** Injectable for tests; the default is the official SDK's ResponsesWS. */
  connect?: () => OpenAiResponsesConnection;
}

export interface OpenAiResponsesModel extends Model {
  /** Close the reusable WebSocket and fail any generations still using it. */
  close(): void;
}

interface ResponsesLane extends AsyncIterable<StreamEnvelope> {
  send(event: ResponsesClientEvent): void;
  /** Stop this consumer while leaving the shared transport available to other lanes. */
  cancel(): void;
  /** Release a terminal lane for reuse, or quarantine an unfinished lane. */
  release(terminal: boolean): void;
}

interface HubLane {
  active: boolean;
  queue: EnvelopeQueue;
}

class ResponsesHub {
  readonly #connection: OpenAiResponsesConnection;
  readonly #lanes = new Map<string, HubLane>();
  readonly #freeIds: string[] = [];
  readonly #onEnd: () => void;
  #activeResponses = 0;
  #issuedIds = 0;
  #retiring = false;
  #ended = false;

  constructor(connection: OpenAiResponsesConnection, onEnd: () => void) {
    this.#connection = connection;
    this.#onEnd = onEnd;
    void this.#read();
  }

  open(): ResponsesLane | undefined {
    if (this.#ended || this.#retiring || this.#activeResponses >= maxActiveResponses) return undefined;
    let id = this.#freeIds.pop();
    if (!id) {
      if (this.#issuedIds >= maxStreamIds) return undefined;
      id = `aglib-${crypto.randomUUID()}`;
      this.#issuedIds += 1;
    }
    const queue = new EnvelopeQueue();
    this.#lanes.set(id, { active: true, queue });
    this.#activeResponses += 1;
    let released = false;
    const release = (terminal: boolean) => {
      if (released) return;
      released = true;
      this.#release(id, terminal);
    };
    return {
      send: (event) => {
        if (event.type === "response.create") {
          this.#connection.send({ ...event, stream_id: id });
        } else {
          this.#connection.send(event);
        }
      },
      cancel: () => {
        queue.push({ type: "close", reason: "generation cancelled" });
        release(false);
      },
      release,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  retire(): void {
    if (this.#ended) return;
    this.#retiring = true;
    this.#closeWhenDrained();
  }

  close(): void {
    if (this.#ended) return;
    this.#finish({ type: "close", reason: "Responses model closed" });
    this.#connection.close();
  }

  async #read(): Promise<void> {
    try {
      for await (const envelope of this.#connection) {
        if (envelope.type === "message" && envelope.message) {
          const event = envelope.message as unknown as Record<string, unknown>;
          const lane = string(event["stream_id"]);
          if (lane) {
            this.#lanes.get(lane)?.queue.push(envelope);
          } else if (string(event["type"]) === "error") {
            this.#broadcast(envelope);
          } else if (this.#lanes.size === 1) {
            this.#lanes.values().next().value?.queue.push(envelope);
          } else {
            this.#finish({
              type: "error",
              error: new Error("Responses event omitted stream_id while multiple generations were active"),
            });
          }
          continue;
        }
        if (envelope.type === "error" || envelope.type === "close") {
          this.#finish(envelope);
          return;
        }
      }
      this.#finish({ type: "close", reason: "Responses WebSocket ended" });
    } catch (error) {
      this.#finish({ type: "error", error });
    }
  }

  #broadcast(envelope: StreamEnvelope): void {
    for (const lane of this.#lanes.values()) lane.queue.push(envelope);
  }

  #release(id: string, terminal: boolean): void {
    const lane = this.#lanes.get(id);
    if (!lane) return;
    lane.active = false;
    this.#activeResponses -= 1;
    lane.queue.end();
    if (terminal) {
      this.#lanes.delete(id);
      this.#freeIds.push(id);
    } else {
      // An unfinished response can still emit events carrying this stream id.
      // Retire the connection rather than let those events enter another generation.
      this.#retiring = true;
    }
    this.#closeWhenDrained();
  }

  #closeWhenDrained(): void {
    if (this.#retiring && ![...this.#lanes.values()].some((lane) => lane.active)) this.close();
  }

  #finish(envelope: StreamEnvelope): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#broadcast(envelope);
    for (const lane of this.#lanes.values()) lane.queue.end();
    this.#lanes.clear();
    this.#onEnd();
  }
}

class EnvelopeQueue implements AsyncIterableIterator<StreamEnvelope> {
  readonly #values: StreamEnvelope[] = [];
  readonly #waiters: Array<(step: IteratorResult<StreamEnvelope>) => void> = [];
  #ended = false;

  push(value: StreamEnvelope): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<StreamEnvelope>> {
    const value = this.#values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamEnvelope> { return this; }
}

/** OpenAI's Responses wire, including completed output items, async tools and optional steering. */
export function createOpenAiResponsesModel(options: OpenAiResponsesOptions): OpenAiResponsesModel {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.headers ? { defaultHeaders: options.headers } : {}),
  });
  const connect = options.connect ?? (() => {
    const socket = new ResponsesWS(client);
    return {
      send(event: unknown) { socket.send(event as ResponsesClientEvent); },
      close() { socket.close(); },
      [Symbol.asyncIterator]() {
        return socket[Symbol.asyncIterator]() as AsyncIterableIterator<StreamEnvelope>;
      },
    };
  });
  const hubs = new Set<ResponsesHub>();
  let hub: ResponsesHub | undefined;

  const lane = () => {
    const existing = hub?.open();
    if (existing) return existing;
    hub?.retire();
    const next = new ResponsesHub(connect(), () => {
      hubs.delete(next);
      if (hub === next) hub = undefined;
    });
    hubs.add(next);
    hub = next;
    const opened = next.open();
    if (!opened) throw new Error("Responses WebSocket opened without an available lane");
    return opened;
  };

  return {
    id: `${provider}:${options.model}`,
    ...(options.asyncTools ? { asyncTools: true as const } : {}),
    generate(request: ModelRequest): ModelGeneration {
      return generation(lane, options.model, request, options.steering === true);
    },
    close() {
      for (const openHub of [...hubs]) openHub.close();
      hub = undefined;
    },
  };
}

function generation(
  connect: () => ResponsesLane,
  configuredModel: string,
  request: ModelRequest,
  steering: boolean,
): ModelGeneration {
  let connection: ResponsesLane | undefined;
  let activeResponseId: string | undefined;
  let ended = false;
  let wakeStarted!: () => void;
  const started = new Promise<void>((resolve) => { wakeStarted = resolve; });
  const steers: Steer[] = [];
  let steerTail = Promise.resolve();

  const iterator = (async function* (): AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>> {
    if (request.signal?.aborted) {
      ended = true;
      wakeStarted();
      return err(cancelled());
    }

    try {
      connection = connect();
    } catch (error) {
      ended = true;
      wakeStarted();
      return err(providerError(error));
    }
    wakeStarted();

    const abort = () => connection?.cancel();
    request.signal?.addEventListener("abort", abort, { once: true });

    const text: string[] = [];
    const calls = new Map<string, ToolCall>();
    const itemCalls = new Map<string, string>();
    const providerItems: JsonValue[] = [];
    const seenItems = new Set<string>();
    const itemPhases = new Map<string, "commentary" | "final_answer">();
    let usage: Usage = {};
    let servedModel: string | undefined;
    let completed: Record<string, unknown> | undefined;
    let refused = false;
    let terminal = false;

    try {
      connection.send(encodeRequest(configuredModel, request));

      for await (const envelope of connection) {
        if (envelope.type === "error") {
          rejectSteers(steers, providerError(envelope.error));
          return err(providerError(envelope.error));
        }
        if (envelope.type === "close") {
          const failure = request.signal?.aborted
            ? cancelled()
            : { code: "provider" as const, message: `Responses WebSocket closed${envelope.code ? ` (${envelope.code})` : ""}${envelope.reason ? `: ${envelope.reason}` : ""}`, retryable: true };
          rejectSteers(steers, failure);
          return err(failure);
        }
        if (envelope.type !== "message" || !envelope.message) continue;
        const event = envelope.message as unknown as Record<string, unknown>;
        const type = string(event["type"]);

        if (type === "error") {
          const failure = eventError(event);
          rejectSteers(steers, failure);
          return err(failure);
        }

        if (type === "response.created") {
          const response = record(event["response"]);
          const id = string(response?.["id"]);
          if (id) {
            const wasActive = activeResponseId;
            activeResponseId = id;
            servedModel = string(response?.["model"]) ?? servedModel;
            if (wasActive) applyNextSteer(steers, id);
          }
          continue;
        }

        if (type === "response.steer.accepted") {
          const detail = record(event["steer"]);
          const waiting = steers.find((steer) => steer.sent && !steer.providerId && !steer.done);
          if (waiting) waiting.providerId = string(detail?.["id"]);
          continue;
        }
        if (type === "response.steer.failed") {
          const detail = record(event["steer"]);
          const id = string(detail?.["id"]);
          const waiting = (id ? steers.find((steer) => steer.providerId === id) : undefined)
            ?? steers.find((steer) => steer.sent && !steer.done);
          waiting?.reject(eventError(event));
          continue;
        }
        if (type === "response.steer.pending") {
          const detail = record(event["steer"]);
          const id = string(detail?.["id"]);
          const waiting = steers.find((steer) => steer.providerId === id && !steer.done);
          waiting?.reject({
            code: "failed", retryable: true,
            message: "Steering awaits client tool input; replay the durable input at the next model boundary",
          });
          if (completed && noLiveSteers(steers)) {
            terminal = true;
            return finish(completed, text, calls, providerItems, usage, refused, servedModel);
          }
          continue;
        }

        if (type === "response.output_text.delta") {
          const delta = string(event["delta"]);
          const phase = itemPhases.get(string(event["item_id"]) ?? "");
          if (delta) {
            text.push(delta);
            yield { type: "text.delta", text: delta, ...(phase ? { phase } : {}) };
          }
          continue;
        }
        if (type === "response.refusal.delta" || type === "response.refusal.done") {
          refused = true;
          continue;
        }
        if (type === "response.reasoning_summary_text.delta") {
          const delta = string(event["delta"]);
          if (delta) yield { type: "reasoning.delta", text: delta };
          continue;
        }
        if (type === "response.output_item.added") {
          const item = record(event["item"]);
          const itemId = string(item?.["id"]);
          const phase = outputPhase(item?.["phase"]);
          if (itemId && phase) itemPhases.set(itemId, phase);
          if (item?.["type"] === "function_call") {
            const callId = string(item["call_id"]);
            if (itemId && callId) itemCalls.set(itemId, callId);
          }
          continue;
        }
        if (type === "response.function_call_arguments.delta") {
          const callId = itemCalls.get(string(event["item_id"]) ?? "");
          const delta = string(event["delta"]);
          if (callId && delta) yield { type: "tool-call.delta", callId, arguments: delta };
          continue;
        }
        if (type === "response.output_item.done") {
          const item = record(event["item"]);
          if (item) appendItem(providerItems, seenItems, item);
          const call = decodeCall(item);
          if (call && !calls.has(call.callId)) {
            calls.set(call.callId, call);
            yield { type: "tool-call.done", call };
          }
          continue;
        }

        if (type === "response.completed") {
          const response = record(event["response"]);
          if (!response) return err({ code: "provider", message: "Responses completion omitted its response", retryable: true });
          completed = response;
          servedModel = string(response["model"]) ?? servedModel;
          refused ||= hasRefusal(response);
          usage = addUsage(usage, decodeUsage(record(response["usage"])));
          for (const item of array(response["output"])) {
            const value = record(item);
            if (!value) continue;
            appendItem(providerItems, seenItems, value);
            const call = decodeCall(value);
            if (call && !calls.has(call.callId)) {
              calls.set(call.callId, call);
              yield { type: "tool-call.done", call };
            }
          }

          const blocking = [...calls.values()].some((call) => call.async !== true);
          if (blocking) {
            rejectSteers(steers, {
              code: "failed", retryable: true,
              message: "Steering did not reach a successor before client tool input became required",
            });
            terminal = true;
            return finish(response, text, calls, providerItems, usage, refused, servedModel);
          }
          if (noLiveSteers(steers)) {
            terminal = true;
            return finish(response, text, calls, providerItems, usage, refused, servedModel);
          }
          continue;
        }

        if (type === "response.incomplete") {
          const response = record(event["response"]);
          if (!response) return err({ code: "provider", message: "Incomplete event omitted its response", retryable: true });
          for (const item of array(response["output"])) {
            const value = record(item);
            if (value) appendItem(providerItems, seenItems, value);
          }
          usage = addUsage(usage, decodeUsage(record(response["usage"])));
          if (record(response["incomplete_details"])?.["reason"] === "steered") continue;
          rejectSteers(steers, { code: "failed", message: "Response ended incomplete", retryable: true });
          terminal = true;
          return finish(response, text, calls, providerItems, usage, refused || hasRefusal(response), servedModel);
        }

        if (type === "response.failed") {
          const failure = responseFailure(record(event["response"]));
          rejectSteers(steers, failure);
          terminal = true;
          return err(failure);
        }
      }

      const failure = request.signal?.aborted ? cancelled() : {
        code: "provider" as const, message: "Responses WebSocket ended before completion", retryable: true,
      };
      rejectSteers(steers, failure);
      return err(failure);
    } catch (error) {
      const failure = request.signal?.aborted ? cancelled() : providerError(error);
      rejectSteers(steers, failure);
      return err(failure);
    } finally {
      ended = true;
      request.signal?.removeEventListener("abort", abort);
      connection.release(terminal);
      rejectSteers(steers, {
        code: "failed", message: "Generation ended before steering reached a successor", retryable: true,
      });
    }
  })();

  const steer = async (input: readonly Message[]): Promise<ModelSteerResult> => {
    await started;
    if (ended || !connection || !activeResponseId) {
      return { status: "rejected", error: { code: "failed", message: "No active response to steer", retryable: true } };
    }
    const encoded = encodeSteer(input);
    if (!encoded.ok) return { status: "rejected", error: encoded.error };

    let release!: () => void;
    const before = steerTail;
    steerTail = new Promise<void>((resolve) => { release = resolve; });
    await before;
    if (ended || !connection || !activeResponseId) {
      release();
      return { status: "rejected", error: { code: "failed", message: "No active response to steer", retryable: true } };
    }

    const pending = createSteer(release);
    steers.push(pending);
    pending.sent = true;
    connection.send({
      type: "response.steer",
      previous_response_id: activeResponseId,
      input: encoded.value,
    } as ResponsesClientEvent);
    return pending.promise;
  };

  return steering ? Object.assign(iterator, { steer }) : iterator;
}

interface Steer {
  sent: boolean;
  done: boolean;
  providerId?: string;
  promise: Promise<ModelSteerResult>;
  accept(responseId: string): void;
  reject(error: ModelError): void;
}

function createSteer(release: () => void): Steer {
  let resolve!: (result: ModelSteerResult) => void;
  const promise = new Promise<ModelSteerResult>((done) => { resolve = done; });
  const steer: Steer = {
    sent: false, done: false, promise,
    accept(responseId) {
      if (steer.done) return;
      steer.done = true;
      release();
      resolve({ status: "accepted", id: responseId });
    },
    reject(error) {
      if (steer.done) return;
      steer.done = true;
      release();
      resolve({ status: "rejected", error });
    },
  };
  return steer;
}

function applyNextSteer(steers: readonly Steer[], responseId: string): void {
  steers.find((steer) => steer.providerId && !steer.done)?.accept(responseId);
}

const noLiveSteers = (steers: readonly Steer[]) => !steers.some((steer) => steer.sent && !steer.done);

function rejectSteers(steers: readonly Steer[], error: ModelError): void {
  for (const steer of steers) steer.reject(error);
}

function encodeRequest(model: string, request: ModelRequest): ResponsesClientEvent {
  return {
    type: "response.create",
    model,
    store: false,
    include: ["reasoning.encrypted_content"],
    input: encodeMessages(request.messages),
    ...(request.tools?.length ? { tools: request.tools.map(encodeTool) } : {}),
    ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.effort ? { reasoning: { effort: request.effort, summary: "auto" } } : {}),
  } as ResponsesClientEvent;
}

function encodeMessages(messages: readonly Message[]): unknown[] {
  const input: unknown[] = [];
  const calls = new Set<string>();
  const providerCalls = new Set(messages.flatMap((message) =>
    message.role === "assistant" && message.providerState?.provider === provider
      ? message.providerState.items.flatMap((item) => {
        const value = record(item);
        const callId = value?.["type"] === "function_call" ? string(value["call_id"]) : undefined;
        return callId ? [callId] : [];
      })
      : []));
  const reachedProviderCall = new Set<string>();
  const deferredResults = new Map<string, unknown[]>();

  for (const message of messages) {
    if (message.role === "assistant" && message.providerState?.provider === provider) {
      const represented: string[] = [];
      for (const item of message.providerState.items) {
        const value = record(item);
        const callId = value?.["type"] === "function_call" ? string(value["call_id"]) : undefined;
        if (callId && calls.has(callId)) continue;
        if (callId) {
          calls.add(callId);
          reachedProviderCall.add(callId);
          represented.push(callId);
        }
        input.push(item);
      }
      // A fast async tool can finish before the response that launched it has
      // completed. The log keeps that chronology. The provider continuation
      // still requires its whole output before any result that answers it.
      for (const callId of represented) {
        input.push(...(deferredResults.get(callId) ?? []));
        deferredResults.delete(callId);
      }
      continue;
    }
    if (message.role === "tool") {
      const output = {
        type: "function_call_output", call_id: message.callId,
        output: encodeToolOutput(message.content),
      };
      if (providerCalls.has(message.callId) && !reachedProviderCall.has(message.callId)) {
        const waiting = deferredResults.get(message.callId) ?? [];
        waiting.push(output);
        deferredResults.set(message.callId, waiting);
      } else {
        input.push(output);
      }
      continue;
    }
    const role = message.role === "system" ? "developer" : message.role;
    if (message.content.length) {
      input.push({ type: "message", role, content: encodeContent(message.content, role === "assistant") });
    }
    if (message.role === "assistant") {
      for (const call of message.calls ?? []) {
        if (providerCalls.has(call.callId)) continue;
        if (calls.has(call.callId)) continue;
        calls.add(call.callId);
        input.push({
          type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments,
          ...(call.async ? { async: true } : {}),
        });
      }
    }
  }
  for (const outputs of deferredResults.values()) input.push(...outputs);
  return input;
}

function encodeSteer(messages: readonly Message[]): Result<unknown[], ModelError> {
  if (!messages.length || messages.some((message) => message.role !== "user")) {
    return err({ code: "failed", message: "Responses steering accepts one or more user messages only", retryable: false });
  }
  return ok(messages.map((message) => ({
    type: "message", role: "user", content: encodeContent(message.content, false),
  })));
}

function encodeContent(content: Content, output: boolean): unknown {
  if (typeof content === "string") return content;
  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: output ? "output_text" : "input_text", text: part.text });
      continue;
    }
    if (part.type === "image" && !output) {
      parts.push({
        type: "input_image",
        image_url: part.source.kind === "url" ? part.source.url : `data:${part.mediaType};base64,${part.source.data}`,
      });
      continue;
    }
    if (part.type === "file" && !output) {
      parts.push(part.source.kind === "url"
        ? { type: "input_file", file_url: part.source.url }
        : { type: "input_file", file_data: part.source.data, ...(part.name ? { filename: part.name } : {}) });
      continue;
    }
    if (part.type === "opaque" && part.provider === provider) parts.push(part.data);
  }
  return parts;
}

function encodeToolOutput(content: Content): unknown {
  if (typeof content === "string") return content;
  return encodeContent(content, false);
}

const encodeTool = (tool: ToolSpec) => ({
  type: "function" as const,
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  strict: false,
  ...(tool.async === true ? { async: true } : {}),
});

function decodeCall(item: Record<string, unknown> | undefined): ToolCall | undefined {
  if (!item || item["type"] !== "function_call") return undefined;
  const callId = string(item["call_id"]);
  const name = string(item["name"]);
  if (!callId || !name) return undefined;
  return {
    callId,
    name,
    arguments: string(item["arguments"]) || "{}",
    ...(item["async"] === true ? { async: true } : {}),
  };
}

function finish(
  response: Record<string, unknown>,
  text: readonly string[],
  calls: ReadonlyMap<string, ToolCall>,
  providerItems: readonly JsonValue[],
  usage: Usage,
  refused: boolean,
  servedModel?: string,
): Result<ModelResponse, ModelError> {
  const collected = [...calls.values()];
  const reason = string(record(response["incomplete_details"])?.["reason"]);
  const finishReason: ModelResponse["finishReason"] =
    reason === "max_output_tokens" ? "length"
    : reason === "content_filter" || refused ? "refusal"
    : collected.some((call) => call.async !== true) ? "tool-calls"
    : "stop";
  return ok({
    message: { content: text.join(""), ...(collected.length ? { calls: collected } : {}) },
    finishReason,
    usage,
    ...(servedModel ? { model: servedModel } : {}),
    ...(providerItems.length ? { providerState: { provider, items: providerItems } } : {}),
  });
}

function hasRefusal(response: Record<string, unknown>): boolean {
  return array(response["output"]).some((item) =>
    array(record(item)?.["content"]).some((part) => record(part)?.["type"] === "refusal"));
}

function appendItem(target: JsonValue[], seen: Set<string>, item: Record<string, unknown>): void {
  const id = string(item["id"]);
  if (id && seen.has(id)) return;
  if (id) seen.add(id);
  target.push(JSON.parse(JSON.stringify(item)) as JsonValue);
}

function decodeUsage(value: Record<string, unknown> | undefined): Usage {
  if (!value) return {};
  const details = record(value["input_tokens_details"]);
  const input = number(value["input_tokens"]);
  const cached = number(details?.["cached_tokens"]);
  const written = number(details?.["cache_write_tokens"]);
  return {
    ...(input !== undefined ? { inputTokens: Math.max(input - (cached ?? 0) - (written ?? 0), 0) } : {}),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
    ...(number(value["output_tokens"]) !== undefined ? { outputTokens: number(value["output_tokens"]) } : {}),
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  const total: Usage = {};
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const a = left[key];
    const b = right[key];
    if (a !== undefined || b !== undefined) total[key] = (a ?? 0) + (b ?? 0);
  }
  return total;
}

function responseFailure(response: Record<string, unknown> | undefined): ModelError {
  const error = record(response?.["error"]);
  return {
    code: "provider",
    message: string(error?.["message"]) ?? "Responses generation failed",
    retryable: true,
  };
}

function eventError(event: Record<string, unknown>): ModelError {
  const error = record(event["error"]);
  const code = string(error?.["code"]);
  return {
    code: code === "rate_limit_exceeded" ? "rate-limit" : "failed",
    message: string(error?.["message"]) ?? "Responses command failed",
    retryable: code === "rate_limit_exceeded" || code === "server_error" || code === "response_not_found",
  };
}

function providerError(error: unknown): ModelError {
  const message = error instanceof Error ? error.message : String(error ?? "Responses transport failed");
  return { code: "provider", message, retryable: true };
}

const cancelled = (): ModelError => ({ code: "cancelled", message: "Generation cancelled", retryable: false });
const outputPhase = (value: unknown): "commentary" | "final_answer" | undefined =>
  value === "commentary" || value === "final_answer" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" ? value : undefined;
