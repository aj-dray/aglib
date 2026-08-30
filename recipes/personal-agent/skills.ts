/**
 * Skills: markdown files with frontmatter, loaded on demand.
 *
 * Progressive disclosure is the entire design. The run context carries names
 * and one-line descriptions; a body is fetched only when the agent decides it
 * needs one. That keeps the cached prefix small and stable, and it is why a
 * skill system needs no library support at all — it is one tool and one string.
 */
import { defineTool, type Tool } from "aglib";
import { z } from "zod";
import { readdir } from "node:fs/promises";

export interface Skill { name: string; description: string; path: string }

export async function skillTools(directory: string): Promise<{ tools: readonly Tool[]; list(): Promise<readonly Skill[]> }> {
  const list = async (): Promise<readonly Skill[]> => {
    const files = await readdir(directory).catch(() => [] as string[]);
    return Promise.all(files.filter((f) => f.endsWith(".md")).map(async (file) => {
      const { name, description } = parseFrontmatter(await Bun.file(`${directory}/${file}`).text());
      return { name: name ?? file.replace(/\.md$/, ""), description: description ?? "", path: `${directory}/${file}` };
    }));
  };

  return {
    list,
    tools: [defineTool({
      name: "load_skill",
      description: "Load the full instructions for a named skill. Consult the skill index before calling.",
      annotations: { readOnly: true },
      schema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const skill = (await list()).find((entry) => entry.name === name);
        if (!skill) return { content: `No skill named '${name}'.`, isError: true };
        return { content: stripFrontmatter(await Bun.file(skill.path).text()) };
      },
    })],
  };
}

export function renderSkillIndex(skills: readonly Skill[]): string {
  if (!skills.length) return "<skills>none installed</skills>";
  const rows = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `<skills>\nLoad a skill with load_skill(name) before following it.\n${rows}\n</skills>`;
}

/** `---\nname: x\ndescription: y\n---` — the smallest thing that works. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { name: fields.name, description: fields.description };
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}
