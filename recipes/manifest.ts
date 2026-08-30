/** Every runnable recipe. `bun run recipe <name>` and the gate both read this. */
export const recipeManifest = [
  { name: "personal-agent", entry: "recipes/personal-agent/index.ts" },
  { name: "agent-service", entry: "recipes/agent-service/index.ts" },
] as const;

export const recipeNames = recipeManifest.map((recipe) => recipe.name);

/** Printed by a recipe so a smoke run can prove it reached the end. */
export const recipeMarker = (name: string): string => `[recipe:${name}] ok`;
