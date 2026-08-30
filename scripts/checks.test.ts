import { expect, test } from "bun:test";
import { CensusError, coreDependencies, exportsConsumed, layering, readmeRecipes } from "./checks/rules.ts";
import type { Inputs, SourceFile } from "./checks/rules.ts";

const base: Inputs = {
  sourceFiles: [], recipeFiles: [], subpathExports: {}, dependencies: { zod: "^4" },
  readme: "", recipeNames: [], workspaces: [], packageRootTarget: "workspace:*",
};
const inputs = (over: Partial<Inputs>): Inputs => ({ ...base, ...over });
const file = (path: string, text: string): SourceFile => ({ path, text });

// The case that matters most: a rule must fail loudly when it was not looking,
// rather than reporting success over an empty corpus.
test("every rule refuses to report success on empty input", () => {
  expect(() => layering(base)).toThrow(CensusError);
  expect(() => exportsConsumed(base)).toThrow(CensusError);
  expect(() => readmeRecipes(base)).toThrow(CensusError);
  expect(() => coreDependencies(inputs({ dependencies: {} }))).toThrow(CensusError);
});

test("layering catches an import that points up the ladder", () => {
  const clean = layering(inputs({ sourceFiles: [file("src/harness/native/loop.ts", 'from "../../model/model.js"')] }));
  expect(clean).toEqual([]);
  const broken = layering(inputs({ sourceFiles: [file("src/model/model.ts", 'from "../harness/harness.js"')] }));
  expect(broken).toHaveLength(1);
  expect(broken[0]?.subject).toContain("imports harness");
});

test("exports-consumed reports surface no recipe composes", () => {
  const violations = exportsConsumed(inputs({
    subpathExports: { ".": { import: "./dist/index.js" } },
    sourceFiles: [file("src/index.ts", "export { runAgent, orphan } from './run.js';")],
    recipeFiles: [file("recipes/a/index.ts", 'import { runAgent } from "aglib";')],
  }));
  expect(violations.map((violation) => violation.subject)).toEqual(["orphan"]);
});

test("exports-consumed reads every subpath, not only the barrels", () => {
  // The rule used to look at `index.ts` alone, so an adapter or a conformance
  // suite could export whatever it liked — and those are the files new entry
  // points get added to.
  const violations = exportsConsumed(inputs({
    subpathExports: {
      ".": { import: "./dist/index.js" },
      "./sandbox/adapters/docker": { import: "./dist/sandbox/adapters/docker.js" },
    },
    sourceFiles: [
      file("src/index.ts", "export { runAgent } from './run.js';"),
      file("src/sandbox/adapters/docker.ts", "export function createDocker() {}\nexport const stray = 1;"),
    ],
    recipeFiles: [file("recipes/a/index.ts", 'import { runAgent } from "aglib";\nimport { createDocker } from "aglib/sandbox/adapters/docker";')],
  }));
  expect(violations.map((violation) => violation.subject)).toEqual(["stray"]);
});

test("exports-consumed takes a suite the package runs, and still wants the rest composed", () => {
  // The second way surface earns its place. A suite's consumers are adapter
  // authors outside this repository, so no recipe imports it — but the
  // exemption is spent by *running* it here, not by living in the file: `stray`
  // sits in the same suite and nothing executes it.
  const violations = exportsConsumed(inputs({
    subpathExports: {
      ".": { import: "./dist/index.js" },
      "./model/conformance": { import: "./dist/model/conformance.js" },
    },
    sourceFiles: [
      file("src/index.ts", "export { runAgent } from './run.js';"),
      file("src/model/conformance.ts", "export function defineModelConformance() {}\nexport const stray = 1;"),
      file("src/model/conformance.test.ts", "for (const item of defineModelConformance(subject)) test(item.name, item.run);"),
    ],
    recipeFiles: [file("recipes/a/index.ts", 'import { runAgent } from "aglib";')],
  }));
  expect(violations.map((violation) => violation.subject)).toEqual(["stray"]);
});

test("exports-consumed does not take a suite nothing runs", () => {
  const violations = exportsConsumed(inputs({
    subpathExports: { "./model/conformance": { import: "./dist/model/conformance.js" } },
    sourceFiles: [file("src/model/conformance.ts", "export function defineModelConformance() {}")],
    recipeFiles: [file("recipes/a/index.ts", 'import { runAgent } from "aglib";')],
  }));
  expect(violations.map((violation) => violation.subject)).toEqual(["defineModelConformance"]);
});

test("core-dependencies rejects anything but zod", () => {
  expect(coreDependencies(inputs({ dependencies: { zod: "^4", pg: "^8" } })).map((v) => v.subject)).toEqual(["pg"]);
});

test("readme-recipes wants every manifest recipe linked", () => {
  expect(readmeRecipes(inputs({ recipeNames: ["personal-agent"], readme: "see recipes/personal-agent" }))).toEqual([]);
  expect(readmeRecipes(inputs({ recipeNames: ["ghost"], readme: "" }))).toHaveLength(1);
});

