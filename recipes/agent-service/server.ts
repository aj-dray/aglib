/**
 * The service's outward surface: start an agent, list what is running, watch
 * any session live, and message any of them.
 *
 * The UI needs nothing the store does not already do. `/tools/*` is the same
 * surface again for the MCP bridge, so an agent and an operator reach the
 * service through one implementation.
 */
import type { Store } from "aglib/store";
import type { JsonValue } from "aglib";
import { harnesses, harnessFor, type SessionRecord } from "./harnesses.ts";
import { allStatuses, environmentFor, store as storeCredential } from "./credentials.ts";
import { callServiceTool, toolSpecs, type Running } from "./tools.ts";
import { orientation } from "./orientation.ts";


export function serve(input: { store: Store; running: Running; port: number }): string {
  const { store, running } = input;
  // The built interface. Its own package with its own build, because a React
  // app needs a bundler and this recipe otherwise needs none — so it is built
  // on demand rather than by the gate, and its absence says so plainly instead
  // of serving a blank page.
  const ui = new URL("./ui/dist/", import.meta.url).pathname;

  const server = Bun.serve({
    port: input.port,
    idleTimeout: 0,
    routes: {
      "/": () => page(ui),

      /**
       * The harnesses, each already configured, with whether it can be started.
       *
       * A harness that is missing its credential, or that has not been made to
       * work at all, says so here — so the interface can grey it out with the
       * reason instead of offering something the worker would refuse.
       */
      "/api/harnesses": () =>
        Response.json(harnesses.map((harness) => {
          const connected = environmentFor([harness.credential]);
          const why = harness.unavailable ?? (connected.ok ? undefined : `Not connected to ${connected.missing.join(" or ")}.`);
          return {
            id: harness.id,
            title: harness.title,
            summary: harness.summary,
            connected: !why,
            ...(why ? { why } : {}),
            models: harness.models,
            ...(harness.defaultModel ? { defaultModel: harness.defaultModel } : {}),
            effort: harness.effort,
          };
        })),

      // What the service is connected to. Never a value: a status, and for the
      // kinds that need one, the exact command to run.
      "/api/credentials": async () => Response.json(await allStatuses()),

      "/api/credentials/:id": {
        PUT: async (request) => {
          const { value } = await request.json() as { value: string };
          storeCredential(request.params.id, value.trim());
          return Response.json({ ok: true });
        },
        DELETE: (request) => {
          storeCredential(request.params.id, "");
          return Response.json({ ok: true });
        },
      },

      "/api/sessions": {
        // Every session, not just the roots: the left bar shows dispatched
        // children beside the ones an operator started.
        GET: async (request) => {
          const listed = await store.list({ limit: 200 });
          if (!listed.ok) return Response.json({ error: listed.error.message }, { status: 500 });
          // Archived sessions are out of the way, not gone: ask and they are here.
          const withArchived = new URL(request.url).searchParams.has("archived");
          return Response.json(listed.value
            .filter((session) => withArchived || !(session.metadata as { archived?: boolean } | null)?.archived)
            .map((session) => ({
            sessionId: session.sessionId,
            parentSessionId: session.key,
            updatedAt: session.updatedAt,
            running: running.has(session.sessionId),
            ...(session.metadata as unknown as SessionRecord),
          })));
        },

        POST: async (request) => {
          const body = await request.json() as { harness?: string; task: string; title?: string };
          const sessionId = crypto.randomUUID();
          const harness = harnessFor(body.harness as never);
          if (!harness) return Response.json({ error: `No harness named '${body.harness}'.` }, { status: 400 });
          const record: SessionRecord = {
            harness: harness.id,
            title: body.title || body.task.slice(0, 60),
            ...(harness.defaultModel ? { model: harness.defaultModel } : {}),
          };
          const created = await store.create({
            sessionId,
            agent: { id: `agent-${harness.id}`, version: "1" },
            metadata: record as unknown as JsonValue,
          });
          if (!created.ok) return Response.json({ error: created.error.message }, { status: 500 });
          // Create, then enqueue: the session exists before anything is owed on it.
          const queued = await store.append({ sessionId, expectedSeq: 0, entries: [], enqueue: [{ sessionId, input: body.task }] });
          if (!queued.ok) return Response.json({ error: queued.error.message }, { status: 500 });
          return Response.json({ sessionId });
        },
      },

      "/api/sessions/:id": {
        /**
         * Change what this session runs on. Metadata is read afresh each
         * activation, so this takes effect on the next turn and leaves
         * everything already said exactly as it was said.
         */
        PATCH: async (request) => {
          const { model, effort, select, archived } = await request.json() as {
            model?: string; effort?: string;
            select?: Record<string, string | boolean>; archived?: boolean;
          };
          const at = await store.read({ sessionId: request.params.id, afterSeq: Number.MAX_SAFE_INTEGER });
          if (!at.ok) return Response.json({ error: at.error.message }, { status: 404 });
          const written = await store.append({
            sessionId: request.params.id, expectedSeq: at.value.seq, entries: [],
            metadata: {
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
              ...(select ? { select } : {}),
              ...(archived === undefined ? {} : { archived }),
            } as JsonValue,
          });
          return written.ok
            ? Response.json({ ok: true })
            : Response.json({ error: written.error.message }, { status: 409 });
        },

        GET: async (request) => {
          const read = await store.read({ sessionId: request.params.id });
          if (!read.ok) return Response.json({ error: read.error.message }, { status: 404 });
          return Response.json({
            sessionId: read.value.sessionId,
            seq: read.value.seq,
            metadata: read.value.metadata,
            running: running.has(request.params.id),
            entries: read.value.entries,
          });
        },
      },

      "/api/sessions/:id/events": (request) =>
        new Response(entryStream(store, request.params.id, Number(new URL(request.url).searchParams.get("after") ?? 0)), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        }),

      "/api/sessions/:id/messages": {
        POST: async (request) => {
          const { message, priority } = await request.json() as
            { message: string; priority?: "interrupt" | "turn" | "next" };
          const read = await store.read({ sessionId: request.params.id, afterSeq: Number.MAX_SAFE_INTEGER });
          if (!read.ok) return Response.json({ error: read.error.message }, { status: 404 });
          const queued = await store.append({
            sessionId: request.params.id, expectedSeq: read.value.seq, entries: [],
            enqueue: [{ sessionId: request.params.id, input: message, priority: priority ?? "next" }],
          });
          if (!queued.ok) return Response.json({ error: queued.error.message }, { status: 409 });
          const live = running.has(request.params.id);
          // A native agent folds waiting input in at its next safe point, so
          // ending its activation would throw away work for no gain. Anything
          // else has no such point and is interrupted instead.
          const folds = read.value.agent.id.endsWith("native");
          // Only an interrupt ends a turn. A "turn" delivery to a harness with
          // no safe point waits instead — the sender asked for the place that
          // costs nothing, so the answer to "I cannot" is later, not worse.
          if (priority === "interrupt" && live) running.get(request.params.id)?.abort();
          // What actually happened, not what was asked for.
          const readAt = !live || priority === "next" || (priority === "turn" && !folds)
            ? "next"
            : priority;
          return Response.json({ ok: true, readAt });
        },
      },

      // The same tools an operator sees, for the agents themselves.
      "/tools/list": {
        POST: async (request) => {
          const { sessionId } = await request.json() as { sessionId: string };
          return Response.json({ tools: toolSpecs(store, running), instructions: orientation(sessionId) });
        },
      },
      "/tools/call": {
        POST: async (request) => {
          const body = await request.json() as { sessionId: string; name: string; arguments: JsonValue };
          return Response.json(await callServiceTool({ store, running, ...body }));
        },
      },
    },
    // Anything not an API route is the interface: its assets by path, and every
    // other path its entry document, because the routing is done in the browser.
    fetch: async (request) => {
      // `URL` resolves away every dot segment, including the percent-encoded
      // ones, so what is left cannot climb out of `ui`. A form it does not
      // decode stays encoded, and is then a filename rather than a path.
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/") || path.startsWith("/tools/")) return new Response("Not found", { status: 404 });
      const asset = Bun.file(`${ui}${path.replace(/^\/+/, "")}`);
      return (await asset.exists()) ? new Response(asset) : page(ui);
    },
  });

  return `http://127.0.0.1:${server.port}`;
}

/**
 * Poll the log from a cursor. Crude on purpose: a sequence number is the entire
 * resume protocol, so a dropped connection costs a reconnect and nothing else.
 * Swapping this for store-side notification changes this function alone.
 */
function entryStream(store: Store, sessionId: string, after: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor = after;
  let open = true;
  return new ReadableStream({
    async pull(controller) {
      while (open) {
        const read = await store.read({ sessionId, afterSeq: cursor });
        if (!read.ok) { controller.close(); return; }
        for (const entry of read.value.entries) {
          cursor = entry.seq;
          controller.enqueue(encoder.encode(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`));
        }
        if (read.value.entries.length) return;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
    cancel() { open = false; },
  });
}

/** The interface's entry document, or the reason there isn't one. */
async function page(ui: string): Promise<Response> {
  const document_ = Bun.file(`${ui}index.html`);
  if (await document_.exists()) {
    return new Response(document_, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response(
    "The interface has not been built.\n\n  cd recipes/agent-service/ui && npm install && npm run build\n",
    { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
