import type {
  Model, ModelDelta, ModelError, ModelResponse, ProviderState, ToolCall, Usage,
} from "../../model.js";
import { err, ok, type Result } from "../../../result.js";

export interface FakeResponse {
  text?: string;
  calls?: readonly ToolCall[];
  usage?: Usage;
  /** Which model the provider says answered. Absent, like a provider that does not say. */
  model?: string;
  providerState?: ProviderState;
  /**
   * Why the turn ended, where the response's own shape cannot say.
   *
   * Only these two: `stop` and `tool-calls` are already determined by whether
   * there are calls, and a second way to say them would be a second answer to
   * one question. Being cut off at the ceiling or declined by the provider is a
   * fact nothing else here expresses — and without it the loop's two branches
   * for exactly those endings are unreachable from any test.
   */
  finishReason?: "length" | "refusal";
}

/**
 * Returns the given responses in order.
 *
 * Deliberately dumb. It is a real implementation of the port — so it runs the
 * same conformance the providers do — and it has exactly one way to express
 * each fact. Running out of responses is an error, never a repeat: a fake more
 * forgiving than reality quietly makes tests pass that should not.
 */
export function createFakeModel(responses: readonly FakeResponse[]): Model {
  let cursor = 0;
  return {
    id: "fake",
    async *generate({ signal }): AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>> {
      if (signal?.aborted) return err({ code: "cancelled", message: "Generation cancelled", retryable: false });
      const response = responses[cursor];
      cursor += 1;
      if (!response) {
        return err({
          code: "provider",
          message: `Fake model has no response for call ${cursor}; it was given ${responses.length}`,
          retryable: false,
        });
      }
      if (response.text) yield { type: "text.delta", text: response.text };
      return ok({
        message: { content: response.text ?? "", ...(response.calls?.length ? { calls: response.calls } : {}) },
        finishReason: response.finishReason ?? (response.calls?.length ? "tool-calls" : "stop"),
        usage: response.usage ?? {},
        ...(response.model ? { model: response.model } : {}),
        ...(response.providerState ? { providerState: response.providerState } : {}),
      });
    },
  };
}
