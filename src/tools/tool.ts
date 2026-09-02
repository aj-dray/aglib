import type { Content } from "../content.js";

import type { Delivery, ToolCall, ToolResult } from "../session/entry.js";
import type { JsonValue } from "../json.js";
import { err, ok, type Result } from "../result.js";
import { z } from "zod";

/** What a tool tells a model about itself. Declared here because a tool owns it. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema. */
  parameters: JsonValue;
  annotations?: { readOnly?: boolean; sequential?: boolean };
}

export interface ToolContext {
  sessionId: string;
  runId: string;
  callId: string;
  signal: AbortSignal;
  /**
   * Deliver input to another session, committed with this run's own entries.
   * This is the whole of agent-to-agent messaging: spawning a child, replying
   * to a parent and messaging a peer are the same call, and either the sending
   * turn commits with the delivery or neither happens.
   *
   * `from` is not yours to state. The executor stamps this session, because a
   * tool that supplied its own sender could omit it — losing the provenance a
   * recipient reads to tell a peer's message from its user's — or claim to be
   * a session it is not. It was a value two callers each rebuilt from
   * `sessionId`, which is a second field for a fact another field already
   * determines.
   */
  enqueue(delivery: Omit<Delivery, "from">): void;
  /** Progress for a live viewer. Never recovery state. */
  report(data: JsonValue): void;
}

export interface Tool {
  spec: ToolSpec;
  /** Validates raw arguments once, before any authority decision sees them. */
  prepare(raw: unknown): Result<{ input: JsonValue; run(context: ToolContext): Promise<ToolResult> }, ToolResult>;
}

/**
 * The entire permission model.
 *
 * One function over parsed arguments, supplied by the application, which
 * already owns identity, tenancy and policy. There is no grant vocabulary, no
 * principal and no second batch-level hook: anything those expressed, a closure
 * expresses better.
 *
 * Two outcomes, not three. There was a `pause`, which parked the batch and
 * committed an approval request — and nothing could ever resolve it, because
 * resuming an exact batch is only possible in a harness we own, and three of
 * the four are not. An approval that works in one harness and dead-ends in the
 * others is worse than none. A call needing permission is rejected with a
 * message saying so; the application asks whoever approves, and their answer
 * arrives as ordinary input on the session, which is a path that already works
 * everywhere. `recipes/agent-service` shows the whole round trip.
 *
 * The gate does not weaken by being a rejection: this runs on every call and
 * cannot be routed around. What an application gives up is exact-argument
 * replay, since the model re-issues rather than resuming. An application that
 * needs the stronger thing keys its approval on the call id and a hash of the
 * parsed input, so a re-issue that differs misses and is refused again.
 */
export type Decide = (call: {
  tool: ToolSpec;
  input: JsonValue;
  sessionId: string;
  runId: string;
  callId: string;
}) =>
  | { action: "execute" }
  | { action: "reject"; message: string }
  | Promise<{ action: "execute" } | { action: "reject"; message: string }>;

/** What a harness is handed to reach application tools. */
export interface ToolExecutor {
  list(): readonly ToolSpec[];
  execute(input: { calls: readonly ToolCall[]; signal?: AbortSignal }):
    Promise<{ results: readonly { callId: string; result: ToolResult }[] }>;
}

/**
 * Declares a tool from a runtime schema. The argument type of `execute` is
 * derived from that schema, so there is never a hand-maintained interface to
 * keep in step with the validation.
 */
export function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  description: string;
  schema: TSchema;
  annotations?: ToolSpec["annotations"];
  execute(args: z.output<TSchema>, context: ToolContext): ToolResult | Promise<ToolResult>;
}): Tool {
  const parameters = z.toJSONSchema(input.schema) as JsonValue;
  return Object.freeze({
    spec: Object.freeze({
      name: input.name,
      description: input.description,
      parameters,
      ...(input.annotations ? { annotations: input.annotations } : {}),
    }),
    prepare(raw: unknown) {
      const parsed = input.schema.safeParse(raw);
      if (!parsed.success) {
        return err({
          content: `Invalid arguments for ${input.name}: ${z.prettifyError(parsed.error)}`,
          isError: true,
        });
      }
      return ok({
        input: parsed.data as JsonValue,
        // Throws are normalized by the executor, which has to cover
        // hand-written tools anyway; catching here too would be dead code.
        run: async (context: ToolContext) => input.execute(parsed.data as z.output<TSchema>, context),
      });
    },
  });
}

/** Re-exported for the same reason the model port re-exports its own. */
export type { Content, ToolResult };
