import { join } from "node:path";

/**
 * Everything this service keeps on disk: sandboxes, pasted credentials, and the
 * per-vendor directories a CLI login writes into.
 *
 * Its own module because both the sandbox chooser and the credential store need
 * it, and each needs the other — the chooser asks for a key, the store asks
 * where to put one. One shared constant breaks the cycle.
 */
export const serviceHome = process.env["SERVICE_HOME"] ?? join(process.env["HOME"] ?? ".", ".agent-service");
