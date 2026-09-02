/**
 * Reaching the agent from somewhere that is not a terminal.
 *
 * Email is the example because it is the least forgiving one: messages arrive
 * when nothing is running, a reply may take minutes, and the same person writes
 * from two addresses. None of that needs anything the library does not already
 * have — a channel is a function that maps an inbound message onto a session
 * and appends a delivery, and a worker that was already draining the queue
 * picks it up. There is no gateway type, no channel registry, and no adapter.
 *
 * The mapping is the only decision, and it is an application's to make:
 *
 *   - **A thread is a session.** The mail thread id is the conversation, so a
 *     reply continues the log rather than starting a new one. Where a provider
 *     gives none, the subject line with `Re:` stripped is the usual stand-in.
 *   - **A sender is a key.** `key` is aglib's opaque index, so listing one
 *     person's conversations is `store.list({ key })` and nothing here has to
 *     know what an address is.
 *   - **Delivery is `next`, not `interrupt`.** Mail is not urgent enough to
 *     throw away a turn's work, and a message that arrives mid-run is answered
 *     when the run ends.
 *
 * What this file does not do is fetch mail or send it. IMAP, a webhook, and an
 * SMTP credential are deployment, and putting them here would make a recipe
 * that cannot run without a mailbox.
 */
import type { Store } from "aglib/store";

export interface Inbound {
  /** The provider's thread identifier, or the subject with `Re:` stripped. */
  thread: string;
  /** Who wrote. Becomes the session key, so one person's mail is one index. */
  sender: string;
  body: string;
}

export interface Delivered { sessionId: string; opened: boolean }

/**
 * Put an inbound message in front of the agent, opening the thread's session
 * the first time that thread is seen.
 *
 * The session id has to be a UUID, and a thread id is not one, so the thread
 * lives in `key` and the lookup is a list. That is the whole of "channel
 * mapping": one index read, and a delivery.
 */
export async function receive(input: {
  store: Store;
  agent: { id: string; version: string };
  message: Inbound;
}): Promise<Delivered> {
  const key = `email:${input.message.sender}:${input.message.thread}`;
  const existing = await input.store.list({ key, limit: 1 });
  if (!existing.ok) throw new Error(`store: ${existing.error.message}`);

  const found = existing.value[0];
  const sessionId = found?.sessionId ?? crypto.randomUUID();
  if (!found) {
    const created = await input.store.create({ sessionId, agent: input.agent, key });
    if (!created.ok) throw new Error(`store: ${created.error.message}`);
  }

  const read = await input.store.read({ sessionId });
  if (!read.ok) throw new Error(`store: ${read.error.message}`);

  const appended = await input.store.append({
    sessionId,
    expectedSeq: read.value.seq,
    entries: [],
    // To itself, so the worker's `next()` hands it back with the claim. A
    // channel writes nothing to the log directly: what the agent received is
    // recorded by the activation that receives it, once, in one place.
    enqueue: [{ sessionId, input: input.message.body, from: { kind: "email", id: input.message.sender } }],
  });
  if (!appended.ok) throw new Error(`store: ${appended.error.message}`);
  return { sessionId, opened: !found };
}
