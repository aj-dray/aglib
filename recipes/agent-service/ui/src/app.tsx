import { useCallback, useEffect, useMemo, useState } from "react";
import {
  harnesses as listHarnesses,
  sessions as listSessions,
  startSession,
  tuneSession,
  type Harness,
  type SessionSummary,
} from "./api";
import { messageOf } from "./errors";
import { Session } from "./session";
import { Settings } from "./settings";
import { Picker } from "./picker";

type View = { kind: "draft" } | { kind: "settings" } | { kind: "session"; sessionId: string };

/** How often the left bar catches up with what the service is running. */
const POLL_MS = 1500;

export function App() {
  const [harnesses, setHarnesses] = useState<readonly Harness[]>([]);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "draft" });
  // Right-click on a session. One item, so it is a menu rather than a dialog.
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number }>();
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    listSessions().then(
      // Hold the array the list already has when the answer is the same one:
      // re-rendering the bar over an unchanged answer is churn under the pointer.
      (fresh) => setSessions((held) => (JSON.stringify(held) === JSON.stringify(fresh) ? held : fresh)),
      (cause: unknown) => setError(messageOf(cause)),
    );
  }, []);

  useEffect(() => {
    listHarnesses().then(setHarnesses, (cause: unknown) => setError(messageOf(cause)));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(undefined);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);

  const archive = async (sessionId: string) => {
    setMenu(undefined);
    await tuneSession(sessionId, { archived: true });
    if (view.kind === "session" && view.sessionId === sessionId) setView({ kind: "draft" });
    refresh();
  };

  const ordered = useMemo(() => nest(sessions), [sessions]);
  const open = view.kind === "session"
    ? sessions.find((session) => session.sessionId === view.sessionId)
    : undefined;

  return (
    <div className="shell">
      <aside>
        <div style={{ padding: "0 6px 4px" }}>
          <button className="flat" onClick={() => setView({ kind: "draft" })}>
            <span>New session</span><kbd>+</kbd>
          </button>
        </div>

        <div className="sessions">
          {ordered.map(({ session, depth }) => (
            <button
              key={session.sessionId}
              className="row"
              style={{ marginLeft: depth * 14 }}
              data-live={session.running}
              aria-current={view.kind === "session" && view.sessionId === session.sessionId}
              onClick={() => setView({ kind: "session", sessionId: session.sessionId })}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ sessionId: session.sessionId, x: event.clientX, y: event.clientY });
              }}
            >
              <span className="name">{session.title || session.sessionId.slice(0, 8)}</span>
              <span className="meta">
                {[session.harness, session.model].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>

        <div className="foot">
          <button className="flat" onClick={() => setView({ kind: "settings" })}>
            <span>Settings</span>
            {harnesses.some((harness) => !harness.connected) && (
              <kbd>{harnesses.filter((harness) => !harness.connected).length}</kbd>
            )}
          </button>
        </div>
        {menu && (
          <div className="menu context" style={{ left: menu.x, top: menu.y }} role="menu">
            <button type="button" role="menuitem" onClick={() => void archive(menu.sessionId)}>
              <span>Archive</span>
            </button>
          </div>
        )}
      </aside>

      <main>
        {error && <div className="wrong">{error}</div>}
        {view.kind === "settings" && <Settings />}
        {view.kind === "draft" && (
          <Draft
            harnesses={harnesses}
            onStarted={(sessionId) => { setView({ kind: "session", sessionId }); refresh(); }}
          />
        )}
        {view.kind === "session" && (
          <Session
            key={view.sessionId}
            sessionId={view.sessionId}
            summary={open}
            harness={harnesses.find((harness) => harness.id === open?.harness)}
          />
        )}
      </main>
    </div>
  );
}

/**
 * A session before it exists: the same thread, empty, with the harness picker
 * live. Choosing one and typing is the whole of starting an agent — there is
 * no form, because everything else about a harness is already decided.
 */
function Draft({ harnesses, onStarted }: {
  harnesses: readonly Harness[];
  onStarted: (sessionId: string) => void;
}) {
  const [harness, setHarness] = useState<string>();
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const usable = harnesses.filter((candidate) => candidate.connected);
  const chosen = harness ?? usable[0]?.id ?? harnesses[0]?.id;
  const picked = harnesses.find((candidate) => candidate.id === chosen);

  const start = async () => {
    if (!chosen || !task.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { sessionId } = await startSession(chosen, task.trim());
      setTask("");
      onStarted(sessionId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header>
        <Picker
          value={chosen}
          choices={harnesses.map((candidate) => ({
            id: candidate.id,
            label: candidate.title,
            ...(candidate.connected
              ? {}
              : { note: candidate.why?.startsWith("Not connected") ? "not connected" : "not configured", disabled: true }),
          }))}
          onPick={setHarness}
        />
        <span className="spacer" />
        <span className="sid">new</span>
      </header>

      <div className="aui-thread-root">
        <div className="aui-thread-viewport">
          {/* Nothing to say when it can run: the composer's placeholder says it. */}
          {picked && !picked.connected && (
            <div className="empty">{picked.why ?? "This harness is not available."}</div>
          )}

          <div className="aui-thread-viewport-footer">
            <form
              className="aui-composer-root"
              onSubmit={(event) => { event.preventDefault(); void start(); }}
            >
              <input
                className="aui-composer-input"
                autoFocus
                placeholder="What should it do?"
                value={task}
                disabled={!picked?.connected}
                onChange={(event) => setTask(event.target.value)}
              />
              <div className="aui-composer-action-wrapper">
                <span className="spacer" />
                <button
                  className="aui-composer-send"
                  type="submit"
                  aria-label="Start"
                  disabled={busy || !task.trim() || !picked?.connected}
                >
                  ↑
                </button>
              </div>
            </form>
            {error && <div className="wrong">{error}</div>}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Children under whoever dispatched them, to any depth: an agent this service
 * dispatched can dispatch in turn, so two levels is not the shape.
 *
 * A session whose parent is not in the list is drawn as a root. Its parent may
 * be archived, or filtered out; either way the session itself is running and
 * hiding it would lose it.
 */
function nest(sessions: readonly SessionSummary[]): { session: SessionSummary; depth: number }[] {
  const known = new Set(sessions.map((session) => session.sessionId));
  const children = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];
  for (const session of sessions) {
    const parent = session.parentSessionId;
    if (parent && known.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), session]);
    } else {
      roots.push(session);
    }
  }
  // A cycle cannot happen — a parent is always older than its child — but the
  // list comes over the wire, so walking one would hang the interface.
  const drawn = new Set<string>();
  const walk = (session: SessionSummary, depth: number): { session: SessionSummary; depth: number }[] => {
    if (drawn.has(session.sessionId)) return [];
    drawn.add(session.sessionId);
    return [
      { session, depth },
      ...(children.get(session.sessionId) ?? []).flatMap((child) => walk(child, depth + 1)),
    ];
  };
  return roots.flatMap((root) => walk(root, 0));
}
