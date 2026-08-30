/**
 * The bridge that carries this service's tools into a foreign agent.
 *
 * Every ACP agent can be handed MCP servers when its session opens, and stdio
 * is the one transport all of them accept — two of the five decline HTTP. So
 * this process is started by the agent, inside the same sandbox, and forwards
 * to the service. It holds no state: the service owns the store.
 */
const service = process.env["AGLIB_SERVICE"];
const session = process.env["AGLIB_SESSION"];

interface Envelope {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const reply = (id: number | string, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

async function ask(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${service}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session, ...(body as object) }),
  });
  return await response.json() as Record<string, unknown>;
}

async function handle(message: Envelope): Promise<void> {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    // Echo the version the agent asked for: this bridge adds no feature that
    // could be incompatible, so whatever it speaks, so do we.
    //
    // `instructions` is the one orientation channel the protocol adapter has.
    // ACP carries no system prompt, so the words that a Claude session gets
    // appended to its preset reach the others here instead, with the tools.
    const listed = await ask("/tools/list", {});
    reply(message.id, {
      protocolVersion: message.params?.["protocolVersion"] ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "aglib-agent-service", version: "0" },
      instructions: String(listed["instructions"] ?? ""),
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, await ask("/tools/list", {}));
    return;
  }
  if (message.method === "tools/call") {
    const answered = await ask("/tools/call", {
      name: message.params?.["name"],
      arguments: message.params?.["arguments"] ?? {},
    });
    reply(message.id, {
      content: [{ type: "text", text: String(answered["content"] ?? "") }],
      isError: answered["isError"] === true,
    });
    return;
  }
  reply(message.id, {});
}

if (!service || !session) {
  process.stderr.write("AGLIB_SERVICE and AGLIB_SESSION must be set.\n");
  process.exit(1);
}

for await (const line of console) {
  if (!line.trim()) continue;
  try { await handle(JSON.parse(line) as Envelope); } catch { /* a malformed line is the agent's bug */ }
}
