import { useState } from "react";
import type { MessageState } from "@assistant-ui/react";
import type { Custom } from "./entries";

type Parts = MessageState["content"];
type Part = Parts[number];

/**
 * One message, in assistant-ui's own clothes.
 *
 * The `aui-` classes are that library's stylesheet, so a message here looks
 * like a message there. What it does not have a vocabulary for — where an
 * input came from, which model answered and how long it took, a tool call
 * folded shut — is added around it rather than instead of it.
 */
export function Turn({ role, content, custom }: {
  role: MessageState["role"];
  content: Parts;
  custom: Custom;
}) {
  if (role === "system") {
    const ending = custom.ending;
    return (
      <div className="close" data-outcome={ending?.outcome ?? "ended"}>
        <span>{[ending?.outcome ?? "ended", ending?.error?.message].filter(Boolean).join(" — ")}</span>
      </div>
    );
  }

  const said = content.map(textOfPart).filter(Boolean).join("\n");
  const calls = content.filter((part): part is Extract<Part, { type: "tool-call" }> => part.type === "tool-call");

  if (role === "user") {
    return (
      <div className="aui-user-message-root">
        <div className="aui-user-message-content-wrapper">
          {custom.from && <div className="origin">from {custom.from.slice(0, 8)}</div>}
          <div className="aui-user-message-content">{said}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="aui-assistant-message-root">
      <div className="aui-assistant-message-content">
        {said}
        {calls.map((call) => <Call key={call.toolCallId} part={call} />)}
        {custom.generation && (
          <div className="stamp">
            {[
              // Only when it is a new one: repeating it every turn says the
              // same thing over and over, and the fact worth reading is that
              // the session was retuned.
              custom.generation.changed ? custom.generation.model : undefined,
              elapsed(custom.generation.startedAt, custom.generation.endedAt),
            ].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

/** A call and its result, one line until you ask for more. */
function Call({ part }: { part: Extract<Part, { type: "tool-call" }> }) {
  const [open, setOpen] = useState(false);
  // A sibling of `result`, not a field on it: `result` is the text the tool
  // returned. Reaching through it found `undefined` every time, and the cast
  // that made that compile is why nothing said so.
  const failed = part.isError === true;

  return (
    <details className="call" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="tool">{part.toolName}</span>
        <span className="gist">{gist(part.argsText)}</span>
        {failed && <span className="bad">failed</span>}
      </summary>
      <pre>{pretty(part.argsText)}</pre>
      {part.result !== undefined && <pre>{asText(part.result)}</pre>}
    </details>
  );
}

const textOfPart = (part: Part): string => {
  if (part.type === "text" || part.type === "reasoning") return part.text;
  if (part.type === "image") return "[image]";
  if (part.type === "file") return `[file ${part.filename ?? part.mimeType}]`;
  return "";
};

const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

/**
 * The one thing worth reading on a collapsed call: the command, the path, the
 * task — whichever it has. Falling back to the whole argument text keeps a
 * tool nobody anticipated from showing an empty line.
 */
function gist(argsText: string): string {
  try {
    const args = JSON.parse(argsText) as Record<string, unknown>;
    for (const key of ["command", "path", "file_path", "task", "message", "query", "sessionId"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").slice(0, 120);
    }
    const first = Object.values(args).find((value) => typeof value === "string");
    return typeof first === "string" ? first.replace(/\s+/g, " ").slice(0, 120) : "";
  } catch {
    return argsText.replace(/\s+/g, " ").slice(0, 120);
  }
}

/** Arguments arrive as the provider sent them; indent them where that parses. */
const pretty = (text: string): string => {
  if (!text.trim()) return "—";
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
};

const elapsed = (startedAt: string, endedAt: string): string => {
  const span = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(span) || span < 0) return "";
  return span < 1000 ? `${span}ms` : `${(span / 1000).toFixed(1)}s`;
};
