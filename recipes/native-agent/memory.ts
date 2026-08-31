/**
 * One markdown file the agent edits, and one tool to edit it with.
 *
 * Three decisions, all taken from Hermes because it has already paid for them:
 *
 * **A tool, not the shell.** The agent has `bash` and could rewrite this file
 * with it. It does not, because a tool can enforce the budget and report what
 * is already there, and because a memory written by a shell redirect is a
 * memory nobody validated.
 *
 * **No read action.** The entries are already in the run context. A read would
 * be a second way to learn what the prompt has just said, and the model would
 * spend a turn on it.
 *
 * **A full file answers with its contents, not an error code.** Over the budget,
 * the failure hands back every entry so the model can consolidate in the same
 * turn. Silent eviction would lose whichever fact the heuristic liked least.
 *
 * What is deliberately not here is a mid-run refresh. Entries are read once, at
 * the start of a run, and land in the cached prefix; a write during the run is
 * durable immediately and visible from the next run. Rewriting the prefix
 * mid-run would invalidate the cache on every turn that followed.
 */
import { defineTool, type Tool } from "aglib";
import { z } from "zod";

/** Roughly a page. Small enough that the whole of it stays worth re-reading. */
export const memoryBudget = 2_000;

const separator = "\n\n---\n\n";

export function parseMemory(text: string): readonly string[] {
  return text.split(/^---$/m).map((entry) => entry.trim()).filter(Boolean);
}

export function renderMemory(entries: readonly string[]): string {
  if (!entries.length) return "<memory>nothing recorded</memory>";
  return `<memory>\n${entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}\n</memory>`;
}

export async function readMemory(path: string): Promise<readonly string[]> {
  return parseMemory(await Bun.file(path).text().catch(() => ""));
}

/** The whole file, or the reason it cannot be written. */
function commit(entries: readonly string[]): { content: string; isError?: true } {
  const written = entries.join(separator);
  if (written.length > memoryBudget) {
    return {
      content:
        `Memory is full (${written.length} of ${memoryBudget} characters). Nothing was written. `
        + "Consolidate or remove an entry in this turn, then write again. Current entries:\n\n"
        + entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n"),
      isError: true,
    };
  }
  return { content: written };
}

export function memoryTools(path: string): readonly Tool[] {
  const save = async (entries: readonly string[], said: string) => {
    const result = commit(entries);
    if (result.isError) return result;
    await Bun.write(path, result.content ? `${result.content}\n` : "");
    return { content: said };
  };

  return [
    defineTool({
      name: "memory",
      description:
        "Edit your durable memory. `add` records a fact worth having in every future conversation; "
        + "`replace` and `remove` find an existing entry by a distinctive substring of it. "
        + "A write applies from the next conversation, not this one. There is no read: your entries are already above.",
      annotations: { sequential: true },
      schema: z.discriminatedUnion("action", [
        z.object({ action: z.literal("add"), text: z.string().min(3) }),
        z.object({ action: z.literal("replace"), find: z.string().min(3), text: z.string().min(3) }),
        z.object({ action: z.literal("remove"), find: z.string().min(3) }),
      ]),
      execute: async (args) => {
        const entries = await readMemory(path);
        if (args.action === "add") {
          return save([...entries, args.text], "Recorded. It is in context from the next conversation.");
        }

        const index = entries.findIndex((entry) => entry.includes(args.find));
        if (index === -1) return { content: `No entry contains '${args.find}'. Nothing was changed.`, isError: true };

        const next = entries.slice();
        if (args.action === "remove") {
          next.splice(index, 1);
          return save(next, `Removed entry ${index + 1}.`);
        }
        next[index] = args.text;
        return save(next, `Replaced entry ${index + 1}.`);
      },
    }),
  ];
}
