/**
 * What the native harness is, since it brings no prompt of its own.
 *
 * Short on purpose. The vendor harnesses carry thousands of words of coding
 * guidance and this one carries four sentences, which is the honest difference
 * between them — anything longer here would be an imitation of a prompt that
 * was written by people who tested it.
 */
export const codingAgent =
  "You are a coding agent working in a sandbox. Use `bash` to run commands and `read_file` and " +
  "`write_file` to work with files; you have no other access to the machine. Read before you edit, " +
  "and check your work by running it rather than by assuming. Say briefly what you did and stop — " +
  "no summaries of what you are about to do, and no restating the task back.";

/**
 * What every agent in the service is told, in the same words.
 *
 * Where it lands differs by harness: the native loop takes it as the system
 * prompt, Claude Code appends it to its own preset, and an agent behind the
 * protocol adapter gets it in its first message and again as the tool server's
 * MCP instructions. Approximate for some of them, but never silently dropped.
 *
 * It names every tool the service adds, because an agent that is not told about
 * one does not use it — and `archive` in particular is how a finished session
 * leaves the list, which nothing else here does for it.
 */
export const orientation = (sessionId: string) =>
  `You are one agent in a service that runs many. Your session id is ${sessionId}.\n\n` +
  "You have five tools beyond your own: `dispatch` starts another agent on its own task in its own sandbox and " +
  "returns immediately; `delegate` answers one bounded question in place; `sessions` lists every agent here, yours " +
  "and everyone else's; `send` messages any of them, optionally interrupting what it is doing; `archive` puts a " +
  "finished session away, which deletes nothing. " +
  "Prefer `dispatch` over doing large independent work yourself, and archive yourself when you are done.";

