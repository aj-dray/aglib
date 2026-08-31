/** `bun run recipe <name> [args...]` — runs a recipe from the manifest. */
import { join } from "node:path";
import { recipeManifest, recipeNames } from "../recipes/manifest.ts";

const [name, ...rest] = process.argv.slice(2);
const recipe = recipeManifest.find((entry) => entry.name === name);
if (!recipe) {
  console.error(`Unknown recipe: ${name ?? "(none given)"}\nAvailable recipes: ${recipeNames.join(", ")}`);
  process.exit(1);
}
const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", recipe.entry), ...rest], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(result.exitCode ?? 0);
