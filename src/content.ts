import type { JsonValue } from "./json.js";

export type ContentSource =
  | { kind: "inline"; data: string }
  | { kind: "url"; url: string };

/**
 * What a turn or a tool result is made of. Parts rather than a string because
 * some content cannot honestly be made into one: a screenshot, a PDF, a block
 * only the provider that produced it can interpret.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; source: ContentSource }
  | { type: "file"; mediaType: string; name?: string; source: ContentSource }
  /**
   * A block this package does not model — provider-executed search, server-side
   * reasoning, anything with a signature. Kept verbatim so the provider that
   * produced it can be handed it back, never interpreted, and never shown to
   * the model as text. `provider` names who made it: one provider's block is
   * not valid on another's wire.
   */
  | { type: "opaque"; provider: string; data: JsonValue };

export type Content = string | readonly ContentPart[];

/**
 * The model-visible text of some content: text parts only, joined by newline.
 * The single projection from parts to a string — images, files and opaque
 * blocks are deliberately dropped rather than stringified into a transcript.
 */
export function textOf(content: Content): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
