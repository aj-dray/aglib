import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  MessageNotSentError,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  entries as openEntries,
  message as postMessage,
  session as readSession,
  tuneSession,
  type Harness,
  type Priority,
  type SessionDetail,
  type SessionSummary,
  type Stored,
} from "./api";
import { customOf, project } from "./entries";
import { messageOf } from "./errors";
import { Turn } from "./turn";
import { Picker } from "./picker";

const PRIORITIES: readonly { value: Priority; label: string }[] = [
  { value: "next", label: "next turn" },
  { value: "turn", label: "this turn" },
  { value: "interrupt", label: "interrupt" },
];

/** What the service said it did, which is not always what was asked for. */
const LANDED: Readonly<Record<Priority, string>> = {
  interrupt: "Sent — its activation was ended so it reads you first.",
  turn: "Sent — folded into the turn it is running.",
  next: "Sent — it reads this at the start of its next activation.",
};

const EFFORTS = ["low", "medium", "high"] as const;

/** A boolean option publishes no choices, so it needs the only two it has. */
const BOOLEAN = [{ id: "true", name: "on" }, { id: "false", name: "off" }] as const;

export function Session({ sessionId, summary, harness }: {
  sessionId: string;
  summary: SessionSummary | undefined;
  harness: Harness | undefined;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [log, setLog] = useState<readonly Stored[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [priority, setPriority] = useState<Priority>("next");
  // onNew is handed to the runtime once; the priority it reads has to be the
  // one showing beside the send button, not the one that was showing when the
  // session opened.
  const chosen = useRef<Priority>(priority);
  chosen.current = priority;

  useEffect(() => {
    let live = true;
    let close = () => {};
    setDetail(null);
    setLog([]);
    setError("");
    setNotice("");
    readSession(sessionId).then(
      (opened) => {
        if (!live) return;
        setDetail(opened);
        setLog(opened.entries);
        close = openEntries(sessionId, opened.seq, (entry) => {
          setLog((held) => {
            const last = held.length ? held[held.length - 1]!.seq : opened.seq;
            return entry.seq <= last ? held : [...held, entry];
          });
          setNotice("");
        });
      },
      (cause: unknown) => {
        if (live) setError(messageOf(cause));
      },
    );
    return () => {
      live = false;
      close();
    };
  }, [sessionId]);

  const messages = useMemo(() => project(log), [log]);

  const onNew = useCallback(
    async (appended: AppendMessage) => {
      const text = appended.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) return;
      setError("");
      // The message is queued, not delivered: it becomes a run.started entry
      // when the agent next activates. Nothing is drawn until it does, so the
      // service's own answer stands in — including when it downgraded a "turn".
      let answer;
      try {
        answer = await postMessage(sessionId, { message: text, priority: chosen.current });
      } catch (cause) {
        const reason = messageOf(cause);
        setError(reason);
        // Nothing reached the log, so the composer takes the text back rather
        // than the operator watching it vanish with nothing to retry.
        throw new MessageNotSentError(reason);
      }
      setNotice(LANDED[answer.readAt] ?? LANDED.next);
    },
    [sessionId],
  );

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (held) => held,
    onNew,
    // Deliberately not `isRunning`. Messaging an agent that is mid-turn is the
    // point of this pane, and a running thread disables the send button.
  });

  const metadata = detail?.metadata ?? {};

  const tune = async (change: {
    model?: string;
    effort?: string;
    select?: Readonly<Record<string, string | boolean>>;
  }) => {
    setError("");
    try {
      await tuneSession(sessionId, change);
    } catch (cause) {
      setError(messageOf(cause));
    }
    // Read back rather than assume. The control then shows what the session
    // holds, which is the only thing that will shape the next turn.
    try {
      const fresh = await readSession(sessionId);
      setDetail((held) => (held ? { ...held, metadata: fresh.metadata, running: fresh.running } : fresh));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  // What the agent said it lets us change, split from the model because the
  // model already has a control and the rest do not.
  const published = metadata.options ?? [];
  const agentModel = published.find((option) => option.category === "model");
  const rest = published.filter((option) => option !== agentModel);

  // The session's own model belongs in the list even when the harness does not
  // publish it, or changing anything else would silently retune the session.
  //
  // A row names models only for an agent whose models we know. The others start
  // empty and fill in from the agent itself the first time it runs, which is
  // the whole reason `options` is persisted rather than re-read every turn.
  const models = useMemo(() => {
    const listed = harness?.models?.length
      ? harness.models
      : (agentModel?.choices ?? []).map((choice) => ({ id: choice.id, title: choice.name }));
    const current = metadata.model;
    return current && !listed.some((model) => model.id === current)
      ? [{ id: current, title: current }, ...listed]
      : listed;
  }, [harness, metadata.model, agentModel]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <header>
        {/* Chosen when the session was made, and not changeable after: a
            harness decides the prompt and the tools, so swapping it mid-thread
            would make the transcript above describe a different agent. */}
        <span className="fixed">{harness?.title ?? metadata.harness ?? summary?.harness}</span>
        <span className="spacer" />
        <span className="sid">{sessionId.slice(0, 8)}</span>
      </header>

      <ThreadPrimitive.Root className="aui-thread-root">
        <ThreadPrimitive.Viewport className="aui-thread-viewport">
          <ThreadPrimitive.Messages>
            {({ message }) => (
              <MessagePrimitive.Root>
                <Turn
                  role={message.role}
                  content={message.content}
                  custom={customOf(message.metadata)}
                />
              </MessagePrimitive.Root>
            )}
          </ThreadPrimitive.Messages>
          <div className="aui-thread-viewport-footer">
            <ComposerPrimitive.Root className="aui-composer-root">
              <ComposerPrimitive.Input
                className="aui-composer-input"
                placeholder="Message this agent…"
                submitMode="enter"
              />
              {/* What this turn runs on sits with the turn you are writing,
                  not in a header above a conversation it did not affect. */}
              <div className="aui-composer-action-wrapper">
                {/* Until the session chooses one, this is whatever the agent
                    told us it is already on — not blank, which would read as
                    "no model" for an agent that plainly has one. */}
                <Picker
                  value={metadata.model || String(agentModel?.current ?? "")}
                  choices={models.map((model) => ({ id: model.id, label: model.title }))}
                  onPick={(id) => void tune({ model: id })}
                  empty={<div className="group">its own default</div>}
                />
                {harness?.effort !== false && (
                  <Picker
                    kind="effort"
                    value={metadata.effort ?? ""}
                    choices={EFFORTS.map((effort) => ({ id: effort, label: effort }))}
                    onPick={(id) => void tune({ effort: id })}
                  />
                )}
                {/* The agent's own controls, in its own words. A harness with
                    three effort levels and one with six reasoning levels are
                    not the same control, so this does not pretend they are. */}
                {rest.map((option) => (
                  <Picker
                    key={option.id}
                    kind={option.name}
                    value={String(metadata.select?.[option.id] ?? option.current)}
                    choices={(option.choices ?? BOOLEAN).map((choice) => ({
                      id: choice.id, label: choice.name,
                    }))}
                    onPick={(id) => void tune({
                      // Merged, not replaced: each control writes its own key
                      // and the session keeps every other choice it holds.
                      select: {
                        ...metadata.select,
                        [option.id]: option.choices ? id : id === "true",
                      },
                    })}
                  />
                ))}
                <span className="spacer" />
                <Picker
                  value={priority}
                  choices={PRIORITIES.map((option) => ({ id: option.value, label: option.label }))}
                  onPick={(id) => setPriority(id as Priority)}
                />
                <ComposerPrimitive.Send className="aui-composer-send" aria-label="Send">↑</ComposerPrimitive.Send>
              </div>
            </ComposerPrimitive.Root>
            {error ? <div className="wrong">{error}</div> : notice ? <div className="wrong">{notice}</div> : null}
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
