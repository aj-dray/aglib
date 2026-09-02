/**
 * Cuts a release: `bun run release patch|minor|major|<version>`.
 *
 * A release is a commit that sets `version` in `package.json`, tagged
 * `v<version>`; pushing the tag is what publishes, and the workflow refuses a
 * tag that disagrees with the manifest. Writing the two apart is how a tag ends
 * up naming a version nobody set, so one command writes both, from a clean
 * `main` that matches `origin/main`, after the gate has passed here.
 */
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const root = join(import.meta.dir, "..");
const manifestPath = join(root, "package.json");

function run(...command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString().trim();
}

function refuse(reason: string): never {
  console.error(`release refused: ${reason}`);
  process.exit(1);
}

const manifest = await readFile(manifestPath, "utf8");
const current = manifest.match(/^ {2}"version": "(\d+)\.(\d+)\.(\d+)",$/m);
if (!current) refuse("package.json has no version line to rewrite");
const [major, minor, patch] = current.slice(1).map(Number) as [number, number, number];

const want = process.argv[2];
const next =
  want === "major" ? `${major + 1}.0.0`
  : want === "minor" ? `${major}.${minor + 1}.0`
  : want === "patch" ? `${major}.${minor}.${patch + 1}`
  : want && /^\d+\.\d+\.\d+$/.test(want) ? want
  : refuse("say patch, minor, major, or an exact x.y.z");

if (run("git", "branch", "--show-current") !== "main") refuse("not on main");
if (run("git", "status", "--porcelain") !== "") refuse("the working tree is not clean");
run("git", "fetch", "--quiet", "origin", "main");
if (run("git", "rev-parse", "HEAD") !== run("git", "rev-parse", "origin/main")) refuse("main is not origin/main; pull or push first");
if (run("git", "ls-remote", "--tags", "origin", `v${next}`) !== "") refuse(`v${next} is already tagged`);

const gate = Bun.spawnSync(["bun", "run", "check"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (gate.exitCode !== 0) refuse("the gate failed; nothing was written");

await writeFile(manifestPath, manifest.replace(current[0], `  "version": "${next}",`));
run("git", "add", "package.json");
run("git", "commit", "--quiet", "--message", `Release v${next}`);
run("git", "tag", `v${next}`);
run("git", "push", "--quiet", "origin", "main", `v${next}`);
console.log(`v${next} pushed; publish.yml is publishing it: https://github.com/aj-dray/aglib/actions`);
