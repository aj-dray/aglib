/**
 * Runs the package's mechanical invariants. `bun run check` fails on any violation.
 *
 * I/O only: this gathers inputs from disk and prints results. The rules are
 * pure and live in `scripts/checks/rules.ts` so they can be tested directly.
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  CensusError, coreDependencies, exportsConsumed, layering, readmeRecipes,
  workspaceDependencies,
  type Inputs, type SourceFile, type Violation,
} from "./checks/rules.ts";
import { recipeNames } from "../recipes/manifest.ts";

const root = join(import.meta.dir, "..");

async function walk(directory: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".ts")) {
      out.push({ path: relative(root, path).replaceAll("\\", "/"), text: await Bun.file(path).text() });
    }
  }
  return out;
}

async function workspaces(): Promise<Inputs["workspaces"]> {
  const out: { directory: string; aglibResolution: string | undefined }[] = [];
  for (const entry of await readdir(join(root, "recipes"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, "recipes", entry.name, "package.json");
    if (!(await Bun.file(manifest).exists())) continue;
    const parsed = await Bun.file(manifest).json() as { dependencies?: Record<string, string> };
    out.push({ directory: `recipes/${entry.name}`, aglibResolution: parsed.dependencies?.aglib });
  }
  return out;
}

const manifest = await Bun.file(join(root, "package.json")).json() as {
  exports: Record<string, unknown>; dependencies: Record<string, string>;
};

const inputs: Inputs = {
  sourceFiles: await walk(join(root, "src")),
  recipeFiles: await walk(join(root, "recipes")),
  subpathExports: manifest.exports,
  dependencies: manifest.dependencies,
  readme: await Bun.file(join(root, "README.md")).text(),
  recipeNames: [...recipeNames],
  workspaces: await workspaces(),
  // `workspace:*` cannot resolve here: the root package IS aglib, and a root is
  // not a member of its own workspace glob, so `bun install` failed outright.
  packageRootTarget: "file:../..",
};

const rules: readonly [string, (inputs: Inputs) => Violation[]][] = [
  ["layering", layering],
  ["core-dependencies", coreDependencies],
  ["exports-consumed", exportsConsumed],
  ["readme-recipes", readmeRecipes],
  ["workspace-dependencies", workspaceDependencies],
];

console.log(
  `checked ${inputs.sourceFiles.length} source files, ${inputs.recipeFiles.length} recipe files, ` +
  `${Object.keys(inputs.subpathExports).length} subpaths, ${inputs.workspaces.length} workspaces`,
);

let failed = false;
for (const [name, rule] of rules) {
  try {
    const violations = rule(inputs);
    if (!violations.length) { console.log(`  ok    ${name}`); continue; }
    failed = true;
    for (const violation of violations) console.log(`  FAIL  ${name}: ${violation.subject}\n        ${violation.fix}`);
  } catch (error) {
    failed = true;
    console.log(`  FAIL  ${error instanceof CensusError ? error.message : String(error)}`);
  }
}
if (failed) process.exit(1);
