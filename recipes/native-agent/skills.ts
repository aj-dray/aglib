/**
 * Skills: a directory per skill, loaded on demand.
 *
 * `~/.agent/skills/<name>/SKILL.md`, which is the shape Hermes and the wider
 * skills ecosystem already use, so a skill written for one works here. The
 * directory rather than a bare file is what lets a skill carry scripts beside
 * its prose.
 *
 * Progressive disclosure is the whole design, and it is why a skill system
 * needs no library support: the run context carries names and one-line
 * descriptions, and a body is fetched only when the agent decides it needs one.
 * Ten skills cost a couple of hundred tokens in the cached prefix instead of
 * twenty thousand.
 *
 * Skills stay on the host and are read here. A skill whose procedure is "run
 * this script" writes the script into the sandbox with `bash` when it gets
 * there — the sandbox port has no mount, and copying on demand is honest about
 * that rather than pretending the directory is present.
 */
import { defineTool, type Tool } from "aglib";
import { z } from "zod";
import { readdir } from "node:fs/promises";

export interface Skill { name: string; description: string; path: string }

export async function listSkills(directory: string): Promise<readonly Skill[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = `${directory}/${entry.name}/SKILL.md`;
    const text = await Bun.file(path).text().catch(() => undefined);
    if (text === undefined) return undefined;
    const { name, description } = parseFrontmatter(text);
    return { name: name ?? entry.name, description: description ?? "", path };
  }));
  return found.filter((skill): skill is Skill => skill !== undefined);
}

export function renderSkillIndex(skills: readonly Skill[]): string {
  if (!skills.length) return "<skills>none installed</skills>";
  const rows = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return `<skills>\nLoad a skill with load_skill(name) before following it.\n${rows}\n</skills>`;
}

export function skillTools(directory: string): readonly Tool[] {
  return [
    defineTool({
      name: "load_skill",
      description: "Load the full instructions for a named skill. Consult the skill index above before calling.",
      annotations: { readOnly: true },
      schema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const skill = (await listSkills(directory)).find((entry) => entry.name === name);
        if (!skill) return { content: `No skill named '${name}'.`, isError: true };
        return { content: stripFrontmatter(await Bun.file(skill.path).text()) };
      },
    }),
  ];
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
  return { name: fields["name"], description: fields["description"] };
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}
