/** Every runnable recipe. `bun run recipe <name>` and the gate both read this. */
export const recipeManifest = [
  { name: "native-agent", entry: "recipes/native-agent/index.ts" },
  { name: "vendored-agent", entry: "recipes/vendored-agent/index.ts" },
  { name: "coding-agent", entry: "recipes/coding-agent/index.ts" },
] as const;

export const recipeNames = recipeManifest.map((recipe) => recipe.name);

/** Printed by a recipe so a smoke run can prove it reached the end. */
export const recipeMarker = (name: string): string => `[recipe:${name}] ok`;
