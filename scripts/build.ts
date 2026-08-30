import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
const build = Bun.spawn(
  [join(root, "node_modules", ".bin", "tsc"), "-p", join(root, "tsconfig.build.json")],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);
