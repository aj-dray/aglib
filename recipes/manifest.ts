/** Every runnable recipe. `bun run recipe <name>` and the gate both read this. */
export const recipeManifest = [
  { name: "native-agents", entry: "recipes/native-agents/index.ts" },
  { name: "vendored-agents", entry: "recipes/vendored-agents/index.ts" },
  { name: "coding-agents", entry: "recipes/coding-agents/index.ts" },
] as const;

export const recipeNames = recipeManifest.map((recipe) => recipe.name);

/** Printed by a recipe so a smoke run can prove it reached the end. */
export const recipeMarker = (name: string): string => `[recipe:${name}] ok`;
