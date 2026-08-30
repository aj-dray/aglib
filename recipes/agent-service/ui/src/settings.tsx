import { useEffect, useState } from "react";
import { credentials as readCredentials, saveCredential, type Credential } from "./api";
import { messageOf } from "./errors";

/** Connections, in two groups: what the service runs on, and what an agent signs in with. */
export function Settings() {
  const [rows, setRows] = useState<readonly Credential[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const refresh = () =>
    readCredentials().then(setRows, (cause: unknown) => setError(messageOf(cause)));
  useEffect(() => { void refresh(); }, []);

  const save = async (id: string) => {
    const value = (drafts[id] ?? "").trim();
    if (!value) return;
    try {
      await saveCredential(id, value);
      setDrafts((held) => ({ ...held, [id]: "" }));
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const group = (kind: Credential["kind"]) => rows.filter((row) => row.kind === kind);

  const credential = (row: Credential) => (
    <div className="cred" key={row.id}>
      <div className="head">
        <b>{row.title}</b>
        <span className="state" data-on={row.connected}>
          {row.connected ? "connected" : "not set"}
        </span>
      </div>
      <p>{row.help}</p>
      {row.command && <code>{row.command}</code>}
      {row.via !== "login" && (
        <form
          onSubmit={(event) => { event.preventDefault(); void save(row.id); }}
        >
          <input
            type="password"
            placeholder={row.connected ? "paste to replace" : "paste here"}
            value={drafts[row.id] ?? ""}
            onChange={(event) => setDrafts((held) => ({ ...held, [row.id]: event.target.value }))}
          />
          <button className="send" type="submit" disabled={!(drafts[row.id] ?? "").trim()}>
            Save
          </button>
        </form>
      )}
    </div>
  );

  return (
    <div className="pane">
      <h2>Connections</h2>
      {error && <div className="wrong">{error}</div>}
      <div className="group-label">Service</div>
      {group("infrastructure").map(credential)}
      <div className="group-label">Agents</div>
      {group("agent").map(credential)}
    </div>
  );
}
