/**
 * The mechanical invariants, as pure functions over gathered inputs.
 *
 * Pure so they can be tested against fixtures — including the case that matters
 * most, a rule that must fail loudly on empty input rather than report success.
 * A check that cannot tell "nothing is wrong" from "I was not looking" is worse
 * than no check, because it is green while blind.
 */
export interface SourceFile { path: string; text: string }

export interface Inputs {
  sourceFiles: readonly SourceFile[];
  recipeFiles: readonly SourceFile[];
  subpathExports: Readonly<Record<string, unknown>>;
  dependencies: Readonly<Record<string, string>>;
  readme: string;
  recipeNames: readonly string[];
  workspaces: readonly { directory: string; aglibResolution: string | undefined }[];
  packageRootTarget: string;
}

export interface Violation { rule: string; subject: string; fix: string }

export class CensusError extends Error {
  constructor(readonly rule: string, detail: string) {
    super(`${rule}: refusing to report success — ${detail}`);
  }
}

function census(rule: string, ok: boolean, detail: string): void {
  if (!ok) throw new CensusError(rule, detail);
}

/**
 * Module rank. A file may import its own module or any lower one, never higher.
 * The four ports sit at the same rank because none may import another: a store
 * knows nothing of harnesses, a harness nothing of stores.
 */
const moduleRank: Readonly<Record<string, number>> = {
  session: 1,
  tools: 2,
  model: 3,
  store: 3,
  sandbox: 3,
  harness: 4,
};

/** The module a file belongs to; `undefined` for a root file, which may import anything. */
const moduleOf = (path: string): string | undefined => {
  const segments = path.split("/");
  return segments.length > 2 ? segments[1] : undefined;
};

export function layering(inputs: Inputs): Violation[] {
  const sources = inputs.sourceFiles;
  census("layering", sources.length > 0, "no source files walked");
  const modules = new Set(sources.map((file) => moduleOf(file.path)).filter((m): m is string => !!m));
  const unranked = [...modules].filter((m) => moduleRank[m] === undefined);
  census("layering", unranked.length === 0, `module has no declared rank: ${unranked.join(", ")}`);

  const violations: Violation[] = [];
  for (const file of sources) {
    const own = moduleOf(file.path);
    const rank = own === undefined ? undefined : moduleRank[own];
    if (rank === undefined) continue;
    for (const match of file.text.matchAll(/from\s+["']\.\.\/(?:\.\.\/)*([a-z-]+)\//g)) {
      const target = match[1]!;
      const targetRank = moduleRank[target];
      if (targetRank === undefined || targetRank < rank) continue;
      if (target === own) continue;
      violations.push({
        rule: "layering",
        subject: `${file.path} imports ${target}`,
        fix: `${own} may not import ${target}; move the shared contract down, or invert the dependency`,
      });
    }
  }
  return violations;
}

/** Platform libraries and vendor SDKs never enter core dependencies. */
export function coreDependencies(inputs: Inputs): Violation[] {
  const names = Object.keys(inputs.dependencies);
  census("core-dependencies", names.length > 0, "package.json declared no dependencies at all");
  return names.filter((name) => name !== "zod").map((name) => ({
    rule: "core-dependencies",
    subject: name,
    fix: "core depends only on zod; put this behind an adapter in a recipe, or write it dependency-free",
  }));
}

/** Names bound from an `aglib` / `aglib/*` specifier. Import statements only. */
export function importedFromPackage(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']aglib(?:\/[^"']+)?["']/g)) {
    for (const entry of match[1]!.split(",")) {
      const name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * The source file behind each declared subpath.
 *
 * `./dist/store/conformance.js` is `src/store/conformance.ts`. Derived rather
 * than listed, because the map in `package.json` is what a consumer actually
 * reaches and a second list here would be a second answer to the same question.
 */
export function subpathSources(subpathExports: Inputs["subpathExports"]): Set<string> {
  const sources = new Set<string>();
  for (const entry of Object.values(subpathExports)) {
    const target = (entry as { import?: unknown }).import;
    if (typeof target !== "string") continue;
    sources.add(target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"));
  }
  return sources;
}

/** Which of `names` a test in this package actually calls. */
function called(sources: readonly SourceFile[], names: ReadonlySet<string>): Set<string> {
  const run = new Set<string>();
  for (const file of sources) {
    if (!file.path.endsWith(".test.ts")) continue;
    for (const name of names) if (new RegExp(`\\b${name}\\s*\\(`).test(file.text)) run.add(name);
  }
  return run;
}

/**
 * Every public export has a consumer, and there are two ways to be one.
 *
 * A recipe that composes it is the first, and it is what almost every export
 * owes: surface with a cost and nobody calling it is how a small library
 * quietly becomes a large one.
 *
 * A conformance suite is the second, and it cannot answer the first — its
 * consumers are the adapter authors who are not in this repository, so no
 * recipe ever imports it. Read without that, this rule argues every suite out
 * of existence, and it nearly did: the store and sandbox suites pass only
 * because the recipes happen to extend those two ports, and a port whose
 * implementations are all in the package would be told its executable contract
 * was dead weight. What a suite owes instead is to be *run* here, against the
 * implementations that are here. An exported case list nothing executes is
 * worse than an unused export, because it reads as a contract while holding
 * nobody to it — so the exemption is spent by running, not by being a suite.
 *
 * "Public" is every file a declared subpath resolves to, not only the barrels.
 * Reading `index.ts` alone let an adapter or a conformance suite export
 * whatever it liked — which is exactly where surface accumulates, since that is
 * where new entry points get added.
 */
export function exportsConsumed(inputs: Inputs): Violation[] {
  const consumers = inputs.recipeFiles;
  census("exports-consumed", consumers.length > 0, "no recipe files walked");
  const used = new Set<string>();
  for (const file of consumers) for (const name of importedFromPackage(file.text)) used.add(name);
  census("exports-consumed", used.size > 0, "no recipe imported anything from aglib");

  const surfaces = subpathSources(inputs.subpathExports);
  census("exports-consumed", surfaces.size > 0, "package.json declared no subpath sources");

  // Value exports only. A type is public surface the moment a value's signature
  // mentions it, so requiring a recipe to import it by name would force noise.
  const exported = new Set<string>();
  const suites = new Set<string>();
  for (const file of inputs.sourceFiles) {
    if (!surfaces.has(file.path)) continue;
    // A suite is a file, not a naming convention: `conformance.ts` beside the
    // port it belongs to, which is where CODE.md already puts it.
    const suite = file.path.endsWith("/conformance.ts");
    const note = (name: string): void => { exported.add(name); if (suite) suites.add(name); };
    for (const match of file.text.matchAll(/export\s+\{([^}]*)\}/g)) {
      for (const entry of match[1]!.split(",")) {
        const name = entry.trim().split(/\s+as\s+/).at(-1)!.trim();
        if (name) note(name);
      }
    }
    for (const match of file.text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)) {
      note(match[1]!);
    }
  }
  census("exports-consumed", exported.size > 0, "no subpath source exported a value");
  const proven = called(inputs.sourceFiles, suites);

  return [...exported].filter((name) => !used.has(name) && !proven.has(name)).map((name) => ({
    rule: "exports-consumed",
    subject: name,
    fix: "give it a recipe that composes it — or, for a conformance suite, a test that runs it against an implementation here — or delete the export",
  }));
}

/** Every recipe in the manifest is listed in the README, and vice versa. */
export function readmeRecipes(inputs: Inputs): Violation[] {
  census("readme-recipes", inputs.recipeNames.length > 0, "the manifest listed no recipes");
  return inputs.recipeNames
    .filter((name) => !inputs.readme.includes(`recipes/${name}`))
    .map((name) => ({
      rule: "readme-recipes",
      subject: name,
      fix: `link recipes/${name} from README.md, or remove it from the manifest`,
    }));
}

/** Each sandbox resolves `aglib` to this package, never to a copy. */
export function workspaceDependencies(inputs: Inputs): Violation[] {
  census("workspace-dependencies", inputs.workspaces.length > 0, "no workspaces discovered");
  return inputs.workspaces
    .filter((workspace) => workspace.aglibResolution !== inputs.packageRootTarget)
    .map((workspace) => ({
      rule: "workspace-dependencies",
      subject: `${workspace.directory} resolves aglib to ${workspace.aglibResolution ?? "nothing"}`,
      fix: `depend on aglib as "${inputs.packageRootTarget}" so the recipe exercises this checkout`,
    }));
}

