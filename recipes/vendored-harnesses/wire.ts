/**
 * A socket in front of the codec, so a client that speaks Anthropic's wire can
 * be answered by any model behind the port.
 *
 * This is the half that is deployment, which is why it is here and the
 * translation is in the package. Everything below is a listener, a route and a
 * bearer token; the moment it has to know what a `tool_use` block is, it calls
 * `aglib/model/anthropic-wire` to find out.
 *
 * What it buys is not a curiosity. The Claude Agent SDK is the deepest
 * integration here — its own prompt, its own context management, its tools
 * replaceable one at a time — and without this it can only ever run on
 * Anthropic. With it, the same harness runs on OpenRouter, on a local
 * endpoint, on anything with a `Model`, and the SDK never knows.
 */
import { collect, type Model } from "aglib/model";
import {
  decodeAnthropicRequest, encodeAnthropicError, encodeAnthropicMessage, encodeAnthropicStream,
} from "aglib/model/anthropic-wire";

export interface WireServer {
  /** What to put in `ANTHROPIC_BASE_URL`. */
  url: string;
  /** What to put in `ANTHROPIC_AUTH_TOKEN`. A client without it is refused. */
  token: string;
  close(): Promise<void>;
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function serveAnthropicWire(input: { model: Model; port?: number }): WireServer {
  // Loopback only, and still behind a token. The process that started this is
  // the only thing meant to reach it, and a bearer check is one line.
  const token = `sk-wire-${crypto.randomUUID()}`;

  const server = Bun.serve({
    port: input.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const presented = request.headers.get("x-api-key")
        ?? request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (presented !== token) {
        return json(encodeAnthropicError({ code: "auth", message: "Bad credential.", retryable: false }), 401);
      }

      // Claude Code asks before it sends. An estimate is honest here in a way
      // it would not be on `usage`: nobody reconciles a bill against it, and
      // refusing the route only makes the client guess instead.
      if (url.pathname === "/v1/messages/count_tokens") {
        const body = await request.text();
        return json({ input_tokens: Math.ceil(body.length / 4) }, 200);
      }
      if (url.pathname !== "/v1/messages" || request.method !== "POST") return json({ type: "error" }, 404);

      const decoded = decodeAnthropicRequest(await request.json());
      if (!decoded.ok) return json(encodeAnthropicError(decoded.error), 400);
      const { request: modelRequest, stream, model: named } = decoded.value;
      const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;

      if (!stream) {
        const result = await collect(input.model.generate({ ...modelRequest, signal: request.signal }));
        if (!result.ok) return json(encodeAnthropicError(result.error), 500);
        return json(encodeAnthropicMessage({ response: result.value, model: named, id }), 200);
      }

      const frames = encodeAnthropicStream({
        generation: input.model.generate({ ...modelRequest, signal: request.signal }),
        model: named,
        id,
      });
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const next = await frames.next();
            if (next.done) { controller.close(); return; }
            controller.enqueue(
              new TextEncoder().encode(`event: ${next.value.event}\ndata: ${JSON.stringify(next.value.data)}\n\n`),
            );
          },
          cancel: () => { void frames.return(undefined as never); },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    close: async () => { await server.stop(true); },
  };
}
