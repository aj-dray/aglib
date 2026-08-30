import type { SandboxProcess } from "../../../sandbox/sandbox.js";
import type { JsonValue } from "../../../json.js";
import { err, ok, type Failure, type Result } from "../../../result.js";

/** Handles a request the agent sends back to us. Rejecting is a JSON-RPC error. */
export type RpcHandler = (params: JsonValue) => Promise<Result<JsonValue, Failure>>;

export interface Rpc {
  request(method: string, params: JsonValue): Promise<Result<JsonValue, Failure>>;
  notify(method: string, params: JsonValue): void;
  /** Register a method the agent may call on us. Unregistered methods answer "method not found". */
  on(method: string, handler: RpcHandler): void;
  onNotify(method: string, handler: (params: JsonValue) => void): void;
  /** Resolves when the process ends; carries whatever it wrote to stderr. */
  readonly closed: Promise<string>;
  close(): void;
}

interface Envelope {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: { code: number; message: string };
}

/**
 * JSON-RPC 2.0 over one process's stdio, newline-delimited.
 *
 * Bidirectional on purpose: the protocol this speaks inverts control for files
 * and terminals, so the agent is as much a caller as a callee and the two
 * directions are the same machinery.
 */
export function createRpc(child: SandboxProcess): Rpc {
  let nextId = 1;
  const pending = new Map<number, (value: Result<JsonValue, Failure>) => void>();
  const requests = new Map<string, RpcHandler>();
  const notifications = new Map<string, (params: JsonValue) => void>();
  let open = true;

  const write = (message: Envelope) => {
    if (open) child.write(`${JSON.stringify(message)}\n`);
  };

  async function dispatch(message: Envelope): Promise<void> {
    if (message.method === undefined) {
      const waiting = message.id === undefined ? undefined : pending.get(Number(message.id));
      if (!waiting) return;
      pending.delete(Number(message.id));
      waiting(message.error
        ? err<Failure>({ code: `rpc-${message.error.code}`, message: message.error.message, retryable: false })
        : ok(message.result ?? null));
      return;
    }
    if (message.id === undefined) {
      notifications.get(message.method)?.(message.params ?? null);
      return;
    }
    const handler = requests.get(message.method);
    if (!handler) {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `No handler for ${message.method}` } });
      return;
    }
    const answered = await handler(message.params ?? null);
    write(answered.ok
      ? { jsonrpc: "2.0", id: message.id, result: answered.value }
      : { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: answered.error.message } });
  }

  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        // A malformed line is the agent's bug, not a reason to drop the stream.
        try { await dispatch(JSON.parse(line) as Envelope); } catch { /* ignore */ }
      }
    }
  })();

  // Held rather than piped: an agent that dies explains itself on stderr, and
  // that explanation is the only useful part of the failure we can report.
  const diagnostics = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
    }
    return text.slice(-4000);
  })();

  const closed = (async () => {
    await child.exited;
    open = false;
    await pump.catch(() => undefined);
    const text = await diagnostics.catch(() => "");
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting(err<Failure>({ code: "closed", message: `The agent exited. ${text}`.trim(), retryable: true }));
    }
    return text;
  })();

  return {
    request(method, params) {
      if (!open) return Promise.resolve(err<Failure>({ code: "closed", message: "The agent has exited.", retryable: true }));
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) { write({ jsonrpc: "2.0", method, params }); },
    on(method, handler) { requests.set(method, handler); },
    onNotify(method, handler) { notifications.set(method, handler); },
    closed,
    close() { open = false; child.kill(); },
  };
}
