/**
 * A socket in front of the codec, so a client that speaks Anthropic's wire can
 * be answered by any model behind the port.
 *
 * This is the half that is deployment, which is why it is here and the
 * translation is in the package. Everything below is a listener, a route and a
 * bearer token; the moment it has to know what a `tool_use` block is, it calls
 * `aglib/model/anthropic-wire` to find out.
 *
 * **Used only where nothing else will do.** Anthropic serves this wire, and so
 * does OpenRouter, so an agent pointed at either goes straight there and keeps
 * its prompt caching, its thinking budget and its real token counts. This is
 * for the third case — a model that speaks neither, reached the way Ollama's
 * own Anthropic endpoint reaches a local one. `route.ts` decides which.
 */
import { collect, type Model } from "aglib/model";
import {
  decodeAnthropicRequest, encodeAnthropicError, encodeAnthropicMessage, encodeAnthropicStream, statusOf,
} from "./anthropic-wire.ts";

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

      // `/v1/messages/count_tokens` is deliberately not served. Answering it
      // would mean counting tokens for a model whose tokenizer we do not have,
      // and the estimate that stood here — bytes over four — is the input to a
      // client's compaction decisions. A missing route makes the client fall
      // back to its own estimate, which is at least its own.
      if (url.pathname !== "/v1/messages" || request.method !== "POST") return json({ type: "error" }, 404);

      const decoded = decodeAnthropicRequest(await request.json());
      if (!decoded.ok) return json(encodeAnthropicError(decoded.error), statusOf(decoded.error));
      const { request: modelRequest, stream, model: named } = decoded.value;
      const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;

      if (!stream) {
        const result = await collect(input.model.generate({ ...modelRequest, signal: request.signal }));
        // The class survives: a client retries a rate limit and does not retry a
        // bad credential, and both looked like 500 before.
        if (!result.ok) return json(encodeAnthropicError(result.error), statusOf(result.error));
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
