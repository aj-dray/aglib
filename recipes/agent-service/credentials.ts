/**
 * What the service needs to be connected to, and how each one connects.
 *
 * One declarative table. Adding a provider or a harness means adding an entry
 * and naming it in `requires` — no new endpoint, no new UI, no new storage
 * code. That is the whole point: the shape below is the extension seam.
 *
 * Three kinds of connection, because vendors genuinely offer three and
 * flattening them into "an api key" would make two of them impossible:
 *
 *   key    — a secret the operator pastes.
 *   token  — a long-lived token the vendor's own CLI mints from a subscription.
 *            This is how a Claude subscription reaches a server: `claude
 *            setup-token` prints one, and the agent reads it from the
 *            environment. No OAuth is implemented here and none needs to be.
 *   login  — the vendor's own OAuth, run once into a directory this service
 *            owns. `codex login` writes `auth.json` under `CODEX_HOME`, so
 *            pointing that at our directory keeps the operator's own machine
 *            login separate from the service's.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Secret } from "aglib/sandbox";
import { serviceHome } from "./home.ts";

/**
 * `hosts` is where the value may be sent, for a sandbox provider that can hold
 * it outside the box and substitute it at egress. Narrow on purpose: a
 * credential that can only be spent at one API is worth much less to code that
 * gets hold of it. Widen an entry if a harness turns out to need another host —
 * the failure is a refused request, which says which host it wanted.
 */
export type Connection =
  | { via: "key"; env: string; hosts: readonly string[] }
  | { via: "token"; env: string; hosts: readonly string[]; mint: readonly string[] }
  | {
      via: "login";
      /** The variable that points the vendor's CLI at our directory instead of the operator's. */
      homeEnv: string;
      login: readonly string[];
      /** Run with `homeEnv` set. Connected when its output does not match `absent`. */
      status: readonly string[];
      absent: string;
      /** The file the login actually writes. Its presence is the proof; a directory is not. */
      marker: string;
    };

export interface CredentialSpec {
  id: string;
  title: string;
  help: string;
  /**
   * Who needs it.
   *
   * "infrastructure" is the service's own: it provisions sandboxes and runs
   * the store, and it is needed before any session exists. Nobody chooses it
   * per session, and a missing one is an outage rather than a setup step.
   *
   * "agent" is what a session authenticates its model or its harness with.
   * That is a choice, made per session, and a missing one fails that session
   * and nothing else.
   */
  kind: "infrastructure" | "agent";
  connection: Connection;
}

export const credentials: readonly CredentialSpec[] = [
  {
    id: "openrouter",
    kind: "agent",
    title: "OpenRouter",
    help: "An API key from openrouter.ai/keys. Used by the native loop and by `delegate`.",
    connection: { via: "key", env: "OPENROUTER_API_KEY", hosts: ["openrouter.ai"] },
  },
  {
    id: "openai",
    kind: "agent",
    title: "OpenAI",
    help: "An API key from platform.openai.com. Only for the native loop; Codex uses the ChatGPT connection.",
    connection: { via: "key", env: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
  },
  {
    id: "daytona",
    kind: "infrastructure",
    title: "Daytona",
    help: "An API key from app.daytona.io. The service's own key for provisioning sandboxes — not something a session picks.",
    connection: { via: "key", env: "DAYTONA_API_KEY", hosts: ["app.daytona.io"] },
  },
  {
    id: "anthropic",
    kind: "agent",
    title: "Anthropic API",
    help: "An API key from console.anthropic.com. For the native loop. Claude Code uses the subscription below.",
    connection: { via: "key", env: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] },
  },
  {
    // A subscription token and an API key are not the same credential: the
    // token authenticates Claude Code against a subscription and is not usable
    // with the Messages API, and the key is the reverse. Listing one entry
    // would make whichever harness got the wrong one fail for no visible
    // reason.
    id: "claude-subscription",
    kind: "agent",
    title: "Claude subscription",
    help:
      "Run `claude setup-token` and paste what it prints. It mints a long-lived token against your Claude " +
      "subscription, which is what lets a server use it. This is what the Claude Code harness authenticates with.",
    connection: {
      via: "token", env: "CLAUDE_CODE_OAUTH_TOKEN", mint: ["claude", "setup-token"],
      hosts: ["api.anthropic.com", "statsig.anthropic.com"],
    },
  },
  {
    id: "chatgpt",
    kind: "agent",
    title: "ChatGPT subscription",
    help:
      "Sign in with Codex's own flow, into this service's directory rather than your own. " +
      "Run the command shown, once.",
    connection: {
      via: "login",
      homeEnv: "CODEX_HOME",
      login: ["codex", "login"],
      status: ["codex", "login", "status"],
      absent: "Not logged in",
      marker: "auth.json",
    },
  },
];

export const credentialFor = (id: string): CredentialSpec | undefined =>
  credentials.find((credential) => credential.id === id);

/** Where a `login` connection keeps its state. One directory per vendor, ours not the operator's. */
export const loginHome = (id: string): string => join(serviceHome, "auth", id);

const file = join(serviceHome, "credentials.json");

type Vault = Record<string, string>;

function read(): Vault {
  try { return JSON.parse(readFileSync(file, "utf8")) as Vault; } catch { return {}; }
}

/** Pasted secrets, readable only by this user. Not a secret manager, and does not pretend to be. */
export function store(id: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const vault = read();
  if (value) vault[id] = value; else delete vault[id];
  writeFileSync(file, JSON.stringify(vault, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * `.env` files, parsed rather than read back off `process.env`.
 *
 * Read once, at startup, to seed the store — never consulted afterwards. The
 * difference between a file and the environment matters and cost an hour to
 * find: this service may be started from inside a coding agent, which exports
 * `ANTHROPIC_API_KEY` and friends of its own, so trusting the inherited
 * environment reported two providers as connected that nobody had connected,
 * with someone else's key. A file the operator wrote is a statement of intent;
 * an inherited variable is an accident.
 */
function dotenv(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const path of [join(process.cwd(), ".env"), join(process.cwd(), "recipes", "agent-service", ".env")]) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      found[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  return found;
}

/**
 * Copy anything a `.env` declares into the store, once, for credentials the
 * store does not already hold.
 *
 * One home rather than two. A value read from a file on every lookup is a
 * second source of truth that the interface cannot edit and the operator
 * cannot see; seeding makes the file a convenience for the first run and the
 * store the answer from then on.
 */
export function seedFromFiles(): readonly string[] {
  const declared = dotenv();
  const stored = read();
  const taken: string[] = [];
  for (const spec of credentials) {
    if (spec.connection.via === "login") continue;
    if (stored[spec.id]) continue;
    const value = declared[spec.connection.env];
    if (!value) continue;
    store(spec.id, value);
    taken.push(spec.id);
  }
  return taken;
}

/** The value. One place: the store. */
function valueOf(spec: CredentialSpec): string | undefined {
  if (spec.connection.via === "login") return undefined;
  return read()[spec.id] || undefined;
}

/** Whether a `login` connection has actually been completed. Asks the vendor's own CLI. */
async function loggedIn(spec: CredentialSpec & { connection: Extract<Connection, { via: "login" }> }): Promise<boolean> {
  const home = loginHome(spec.id);
  mkdirSync(home, { recursive: true });
  const [command, ...rest] = spec.connection.status;
  if (!command) return false;
  try {
    const probe = Bun.spawn([command, ...rest], {
      env: { ...process.env, [spec.connection.homeEnv]: home },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, error] = await Promise.all([
      new Response(probe.stdout).text(), new Response(probe.stderr).text(),
    ]);
    await probe.exited;
    return !`${out}${error}`.includes(spec.connection.absent);
  } catch {
    // The CLI is not installed. Not connected, and the reason is visible.
    return false;
  }
}

export interface CredentialStatus {
  id: string;
  title: string;
  help: string;
  kind: CredentialSpec["kind"];
  via: Connection["via"];
  connected: boolean;
  /** The exact command to run, for the kinds that need one. Never a value. */
  command?: string;
}

/** What the interface shows. Values never leave this module. */
export async function statusOf(spec: CredentialSpec): Promise<CredentialStatus> {
  const base = { id: spec.id, title: spec.title, help: spec.help, kind: spec.kind, via: spec.connection.via };
  if (spec.connection.via === "login") {
    const connection = spec.connection;
    return {
      ...base,
      connected: await loggedIn(spec as never),
      command: `${connection.homeEnv}=${loginHome(spec.id)} ${connection.login.join(" ")}`,
    };
  }
  return {
    ...base,
    connected: Boolean(valueOf(spec)),
    ...(spec.connection.via === "token" ? { command: spec.connection.mint.join(" ") } : {}),
  };
}

export const allStatuses = (): Promise<CredentialStatus[]> => Promise.all(credentials.map(statusOf));

/**
 * What a run needs to authenticate, or the connections it is missing.
 *
 * Composed here rather than read from `process.env` at each use, so a run fails
 * before it spawns anything and names exactly what to connect.
 *
 * Two lists, because a sandbox can treat them differently. A pasted key or
 * token is a `Secret`: a provider that can keep it out of the box and put it in
 * at egress should be given the chance, and one that cannot says so. The
 * variable pointing a CLI at its login directory is a path, not a credential —
 * it has to be readable inside the box for the CLI to find the directory at
 * all, and substituting it would break the thing it is for.
 */
export function environmentFor(
  required: readonly (string | readonly string[])[],
): { ok: true; env: Record<string, string>; secrets: Secret[] } | { ok: false; missing: readonly string[] } {
  const env: Record<string, string> = {};
  const secrets: Secret[] = [];
  const missing: string[] = [];

  const supply = (id: string): boolean => {
    const spec = credentialFor(id);
    if (!spec) return false;
    if (spec.connection.via === "login") {
      // A directory is not a login, and neither is a non-empty one: asking
      // `codex login status` creates the directory and drops a database in it.
      // The file the login writes is the only honest proof.
      const home = loginHome(id);
      if (!existsSync(join(home, spec.connection.marker))) return false;
      env[spec.connection.homeEnv] = home;
      return true;
    }
    const value = valueOf(spec);
    if (!value) return false;
    secrets.push({ env: spec.connection.env, value, hosts: spec.connection.hosts });
    return true;
  };

  for (const requirement of required) {
    const alternatives = typeof requirement === "string" ? [requirement] : requirement;
    if (alternatives.some(supply)) continue;
    missing.push(alternatives.join(" or "));
  }
  return missing.length ? { ok: false, missing } : { ok: true, env, secrets };
}

/** One credential's value, for a caller that needs it directly rather than as an environment. */
export const secret = (id: string): string | undefined => {
  const spec = credentialFor(id);
  return spec ? valueOf(spec) : undefined;
};

/**
 * The environment an agent starts from, with every vendor variable removed.
 *
 * An agent inherits this process's environment, and this service may itself be
 * started from inside a coding agent — which is how a run once picked up the
 * operator's own `ANTHROPIC_MODEL` and failed on a model nobody chose. Anything
 * a credential owns is stripped here and put back only by `environmentFor`, so
 * an unset variable means unset rather than "whatever was lying around".
 */
export function baseEnvironment(): Record<string, string> {
  const owned = new Set(
    credentials.flatMap((credential) =>
      credential.connection.via === "login" ? [credential.connection.homeEnv] : [credential.connection.env]),
  );
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (owned.has(name)) continue;
    // Not credentials, but they steer the same agents and leak the same way.
    if (/^(ANTHROPIC|CLAUDE|CODEX|OPENAI)_/.test(name) || name === "CLAUDECODE") continue;
    clean[name] = value;
  }
  return clean;
}
