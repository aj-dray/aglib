/**
 * What any implementation of the sandbox port must do.
 *
 * The port's central claim is that isolation is requested and either enforced
 * or refused. A provider is the only thing that can honour it, and a provider
 * that overstates what it enforces is worse than one that refuses: the caller
 * asked a question precisely so it would not have to trust an adjective.
 *
 * Two implementations ship, a directory on the host and a container, and they
 * are the same seam only if they answer the same way — down to whether a
 * command's own non-zero exit is an outcome or a failure, whether a missing
 * file is `not-found` or an empty string, and whether a path leaving the root
 * is denied or quietly resolved. Where that differs it differs in production,
 * on the provider nobody develops against.
 *
 * Inert on purpose. Each case is a name and a function that throws, so the
 * suite drags no test framework into the package:
 *
 * ```ts
 * for (const item of defineSandboxConformance(subject)) test(item.name, item.run);
 * ```
 */
import type { NetworkPolicy, Sandbox, SandboxError, SandboxProvider } from "./sandbox.js";
import type { Failure, Result } from "../result.js";

/** One case: a name, and a function that throws when the contract is broken. */
export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

export interface SandboxUnderTest {
  /**
   * The provider under test. A function, not a value, because constructing one
   * may need a credential this run does not have — and a suite that is about to
   * skip every case must not have thrown to find that out.
   */
  provider(): SandboxProvider;
  /**
   * What this provider enforces when isolation is required.
   *
   * `"none"` is a claim, not an omission: a provider that runs on the host must
   * refuse `isolation: "required"` rather than hand back something labelled
   * unisolated, and this suite holds it to that.
   */
  isolation: Sandbox["isolation"];
  /** The outbound posture every case is created with. */
  network: NetworkPolicy;
  /**
   * Postures this provider does not enforce. Each must be refused before
   * anything is provisioned — a policy silently ignored is the one failure a
   * caller cannot detect from the outside.
   */
  refuses?: readonly NetworkPolicy[];
  /**
   * Whether a command's two output streams arrive apart.
   *
   * Declared rather than assumed, because not every backend has them: a hosted
   * box may expose one combined stream, and an adapter over it puts everything
   * in `stdout` and leaves `stderr` empty rather than inventing a split. That
   * is a real difference to an application parsing stderr, so it is said out
   * loud here instead of discovered. Defaults to `"separate"`.
   */
  streams?: "separate" | "combined";
  /**
   * What this provider does with a `Secret`.
   *
   * `"substituted"` is a strong claim — the value never enters the box — so the
   * suite checks that a process there genuinely cannot read it. `"plain"` is
   * checked the other way: the value has to actually arrive, because a provider
   * that quietly dropped it would leave every agent unauthenticated with
   * nothing saying why. Defaults to `"plain"`.
   */
  secrets?: Sandbox["secrets"];
}

function fail(what: string): never {
  throw new Error(`sandbox conformance: ${what}`);
}

function holds(condition: boolean, what: string): asserts condition {
  if (!condition) fail(what);
}

function equals(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) fail(`${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function got<T>(result: Result<T, Failure>, what: string): T {
  if (!result.ok) fail(`${what} — ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function refused(result: Result<unknown, SandboxError>, code: SandboxError["code"], what: string): void {
  holds(!result.ok, `${what} — it succeeded instead`);
  equals(result.error.code, code, what);
}

export function defineSandboxConformance(subject: SandboxUnderTest): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const isolating = subject.isolation !== "none";

  const open = async (extra: Parameters<SandboxProvider["create"]>[0] | object = {}): Promise<Sandbox> =>
    got(
      await subject.provider().create({
        isolation: isolating ? "required" : "none",
        network: subject.network,
        ...extra,
      }),
      "create",
    );

  /** Every case gets its own machine and gives it back, billable or not. */
  const define = (name: string, body: (sandbox: Sandbox) => Promise<void>): void => {
    cases.push({
      name,
      async run() {
        const sandbox = await open();
        try {
          await body(sandbox);
        } finally {
          await sandbox.close();
        }
      },
    });
  };

  // ---- What was actually provisioned --------------------------------------

  cases.push({
    name: "isolation is requested and either enforced or refused",
    async run() {
      const asked = await subject.provider().create({ isolation: "required", network: subject.network });
      if (!isolating) {
        // The whole reason the request is a request. A provider on the host
        // says so by failing, not by setting a field the caller may ignore.
        refused(asked, "unsupported", "a host provider refuses isolation rather than downgrading it");
        return;
      }
      const sandbox = got(asked, "create with isolation required");
      try {
        equals(sandbox.isolation, subject.isolation, "the sandbox reports what it enforces");
      } finally {
        await sandbox.close();
      }
    },
  });

  define("a machine names itself and its root", async (sandbox) => {
    holds(sandbox.id.length > 0, "a sandbox has an id, so it can be reconnected to");
    holds(sandbox.root.startsWith("/"), "the root is an absolute path");
    equals(sandbox.isolation, subject.isolation, "and reports the isolation it enforces, never more");
  });

  if (subject.refuses?.length) {
    for (const network of subject.refuses) {
      cases.push({
        name: `a '${network.mode}' network this provider cannot enforce is refused before anything is provisioned`,
        async run() {
          const asked = await subject.provider().create({
            isolation: isolating ? "required" : "none",
            network,
          });
          if (asked.ok) {
            await asked.value.close();
            fail(`'${network.mode}' was accepted by a provider that does not enforce it`);
          }
          equals(asked.error.code, "unsupported", "the refusal says the posture is unsupported");
        },
      });
    }
  }

  // ---- Commands -----------------------------------------------------------

  define("a command answers with its output and its exit code", async (sandbox) => {
    const ran = got(await sandbox.exec({ command: "echo hello" }), "exec");
    equals(ran.stdout.trim(), "hello", "stdout carries what the command wrote");
    equals(ran.exitCode, 0, "and the exit code it left");
  });

  define("a command's own failure is an outcome, not a failure of the sandbox", async (sandbox) => {
    // The distinction the whole `Result` shape turns on: the sandbox did its
    // job perfectly and the command inside it did not.
    const ran = got(await sandbox.exec({ command: "echo oops >&2; exit 3" }), "exec");
    equals(ran.exitCode, 3, "the command's own code comes back");
    holds(`${ran.stdout}${ran.stderr}`.includes("oops"), "and what it wrote is not lost");
  });

  if ((subject.streams ?? "separate") === "separate") {
    define("stdout and stderr arrive apart", async (sandbox) => {
      const ran = got(await sandbox.exec({ command: "echo out; echo err >&2" }), "exec");
      equals(ran.stdout.trim(), "out", "stdout is what the command wrote to stdout");
      equals(ran.stderr.trim(), "err", "and stderr is what it wrote to stderr");
    });

    define("a spawned process's two streams arrive apart as well", async (sandbox) => {
      // The port hands back both pipes, so both are read here. Read together,
      // because a process filling one while nothing drains the other stops.
      const started = got(await sandbox.spawn({ command: ["sh", "-c", "echo out; echo err >&2"] }), "spawn");
      const [out, errors] = await Promise.all([
        new Response(started.stdout).text(),
        new Response(started.stderr).text(),
      ]);
      equals(out.trim(), "out", "stdout is the stream the process wrote to stdout");
      equals(errors.trim(), "err", "and stderr is the one it wrote to stderr");
      await started.exited;
    });
  }

  define("the environment a command is given reaches it", async (sandbox) => {
    const ran = got(await sandbox.exec({ command: "echo $AGLIB_PROOF", env: { AGLIB_PROOF: "carried" } }), "exec");
    equals(ran.stdout.trim(), "carried", "the value arrives in the command's environment");
  });

  define("a command runs in the working directory it names", async (sandbox) => {
    got(await sandbox.writeFile({ path: "work/marker", content: "here" }), "writeFile");
    const ran = got(await sandbox.exec({ command: "cat marker", cwd: "work" }), "exec");
    equals(ran.stdout.trim(), "here", "a relative path resolves against the directory it was given");
  });

  define("a command given an aborted signal is cancelled rather than run", async (sandbox) => {
    const ran = await sandbox.exec({ command: "echo ran", signal: AbortSignal.abort() });
    refused(ran, "cancelled", "an already-cancelled command reports cancelled");
  });

  // ---- Files --------------------------------------------------------------

  define("a file written is the file read back, in a directory that did not exist", async (sandbox) => {
    got(await sandbox.writeFile({ path: "notes/deep/one.md", content: "kept" }), "writeFile");
    equals(got(await sandbox.readFile({ path: "notes/deep/one.md" }), "readFile"), "kept",
      "the content survives the round trip");
  });

  define("a file that is not there is not-found rather than empty", async (sandbox) => {
    // An empty string is a file that exists and says nothing. The difference
    // matters to every caller that branches on it.
    refused(await sandbox.readFile({ path: "nothing-here.md" }), "not-found", "a missing file is not-found");
  });

  if (!isolating) define("a symlink under the root does not lead out of it", async (sandbox) => {
    // Only asked of a provider that has no other boundary, and that is the
    // whole of the rule: where the root is the only thing between a model and
    // the machine, it has to be a real boundary rather than a lexical one.
    // Lexically `escape/hostname` never leaves the root; on disk it was
    // whatever the link pointed at, and `readFile`/`writeFile` are the calls an
    // application hands to a model. A provider that isolates has a second
    // boundary doing that job, so it is not made to pay a `realpath` per call
    // for a confinement that is tidiness there rather than safety.
    got(await sandbox.writeFile({ path: "inside.txt", content: "mine" }), "writeFile");
    const linked = got(await sandbox.exec({ command: "ln -s /etc escape" }), "link to /etc");
    equals(linked.exitCode, 0, "the link was made");
    refused(await sandbox.readFile({ path: "escape/hostname" }), "denied",
      "reading through a link that leaves the root is denied");
    refused(await sandbox.writeFile({ path: "escape/aglib-should-not-exist", content: "x" }), "denied",
      "writing through it is denied too");
    // And the link is not a reason to refuse what is genuinely inside.
    equals(got(await sandbox.readFile({ path: "inside.txt" }), "readFile"), "mine",
      "a real path in the root still reads");
  });

  define("a command cancelled while it runs is cancelled, and promptly", async (sandbox) => {
    const giving = new AbortController();
    const began = Date.now();
    setTimeout(() => giving.abort(), 200);
    const ran = await sandbox.exec({ command: "sleep 5; echo done", signal: giving.signal });
    const took = Date.now() - began;
    refused(ran, "cancelled", "a command the caller gave up on is cancelled, not completed");
    // The point is the promptness. A provider that waits for the command it was
    // told to abandon has not cancelled anything, whatever it reports.
    holds(took < 3_000, `the answer came back in ${took}ms, after the command it abandoned`);
  });

  define("a path outside the root is denied rather than resolved", async (sandbox) => {
    for (const path of ["../escape.md", "/etc/passwd"]) {
      refused(await sandbox.readFile({ path }), "denied", `reading ${path} is denied`);
      refused(await sandbox.writeFile({ path, content: "x" }), "denied", `writing ${path} is denied`);
    }
    refused(await sandbox.exec({ command: "pwd", cwd: "/etc" }), "denied", "a working directory outside the root is denied");
    // Both methods take a working directory, so both confine it — and a
    // spawned process is the one still running after the call that started it.
    refused(await sandbox.spawn({ command: ["pwd"], cwd: "/etc" }), "denied",
      "a spawned process's working directory outside the root is denied");
  });

  define("a name that begins with dots is a file in the root, not a path out of it", async (sandbox) => {
    // `..hidden` starts with two dots and leaves nothing. A guard that reads
    // the prefix rather than the segment refuses a file it should have written.
    got(await sandbox.writeFile({ path: "..hidden", content: "kept" }), "writeFile");
    equals(got(await sandbox.readFile({ path: "..hidden" }), "readFile"), "kept", "and it reads back");
  });

  define("a file operation given an aborted signal is cancelled rather than run", async (sandbox) => {
    // The same promise `exec` makes. A caller that has already given up is told
    // so, rather than being handed the read it no longer wants.
    refused(await sandbox.readFile({ path: "notes/one.md", signal: AbortSignal.abort() }), "cancelled",
      "an already-cancelled read reports cancelled");
    refused(await sandbox.writeFile({ path: "notes/one.md", content: "x", signal: AbortSignal.abort() }), "cancelled",
      "an already-cancelled write reports cancelled");
  });

  // ---- Processes ----------------------------------------------------------

  define("a spawned process hands back its streams and its exit code", async (sandbox) => {
    const started = got(await sandbox.spawn({ command: ["sh", "-c", "echo streamed; exit 0"] }), "spawn");
    equals((await new Response(started.stdout).text()).trim(), "streamed", "stdout is a stream the caller reads");
    equals(await started.exited, 0, "and the process reports how it ended");
  });

  define("a spawned process starts in the working directory it names", async (sandbox) => {
    got(await sandbox.writeFile({ path: "work/marker", content: "here" }), "writeFile");
    const started = got(await sandbox.spawn({ command: ["cat", "marker"], cwd: "work" }), "spawn");
    equals((await new Response(started.stdout).text()).trim(), "here",
      "a relative path resolves against the directory the process was given");
    await started.exited;
  });

  define("a spawned process is given its environment without publishing it", async (sandbox) => {
    // Both methods carry an environment, and both must carry it the same way.
    // A value on the command line is readable by anything on the host, and an
    // agent's environment is where its credentials are.
    const started = got(
      await sandbox.spawn({ command: ["sh", "-c", "echo $AGLIB_PROOF"], env: { AGLIB_PROOF: "carried" } }),
      "spawn",
    );
    equals((await new Response(started.stdout).text()).trim(), "carried", "the value reaches the process");
    await started.exited;
  });

  define("a spawned process takes what is written to it", async (sandbox) => {
    // The method that makes changing provider a change of location: an agent
    // speaking a protocol over stdio needs a real duplex channel, not a
    // one-shot command.
    const started = got(
      await sandbox.spawn({ command: ["sh", "-c", "read line; echo \"got $line\""] }),
      "spawn",
    );
    started.write("hello\n");
    equals((await new Response(started.stdout).text()).trim(), "got hello", "what was written reached its stdin");
    await started.exited;
  });

  define("a spawned process can be killed", async (sandbox) => {
    const started = got(await sandbox.spawn({ command: ["sh", "-c", "sleep 30"] }), "spawn");
    started.kill();
    await started.exited;
  });

  // ---- Environment and credentials ----------------------------------------

  const substituting = (subject.secrets ?? "plain") === "substituted";

  cases.push({
    name: "the environment a machine was made with reaches everything started in it",
    async run() {
      const sandbox = await open({ env: { CONFORMANCE_ENV: "from-create" } });
      try {
        equals(sandbox.secrets, subject.secrets ?? "plain", "and it says what it does with a secret");
        const ran = got(await sandbox.exec({ command: "echo $CONFORMANCE_ENV" }), "exec");
        equals(ran.stdout.trim(), "from-create", "a command reads what the machine was made with");

        // Both, because they are two code paths in every adapter: one collects
        // and one hands back pipes, and an adapter has passed the environment
        // to one and not the other.
        const started = got(
          await sandbox.spawn({ command: ["sh", "-c", "echo $CONFORMANCE_ENV"] }),
          "spawn",
        );
        equals(
          (await new Response(started.stdout).text()).trim(),
          "from-create",
          "and so does a spawned process",
        );
        await started.exited;
      } finally {
        await sandbox.close();
      }
    },
  });

  cases.push({
    name: "a call's own environment wins over the machine's",
    async run() {
      const sandbox = await open({ env: { CONFORMANCE_ENV: "from-create" } });
      try {
        const ran = got(
          await sandbox.exec({ command: "echo $CONFORMANCE_ENV", env: { CONFORMANCE_ENV: "from-call" } }),
          "exec",
        );
        equals(ran.stdout.trim(), "from-call", "the narrower of the two is the one that applies");
      } finally {
        await sandbox.close();
      }
    },
  });

  cases.push({
    name: substituting
      ? "a secret is not readable inside the machine"
      : "a secret arrives as an environment variable, and the machine says it is plain",
    async run() {
      // Distinctive enough that finding it anywhere is finding this one.
      const value = "conformance-secret-e7f2a1";
      const sandbox = await open({
        secrets: [{ env: "CONFORMANCE_SECRET", value, hosts: ["example.invalid"] }],
      });
      try {
        const ran = got(await sandbox.exec({ command: "echo $CONFORMANCE_SECRET" }), "exec");
        if (substituting) {
          // The whole claim. Something has to be there — a process needs to be
          // able to send it — but the plaintext must not be, or "substituted"
          // is a label rather than a property.
          holds(
            !ran.stdout.includes(value),
            "a provider claiming to substitute must not put the value where a process can read it",
          );
          holds(ran.stdout.trim().length > 0, "though the variable is set, so a process has something to send");
        } else {
          equals(ran.stdout.trim(), value, "a provider that cannot substitute passes the value through");
        }
      } finally {
        await sandbox.close();
      }
    },
  });

  // ---- Lifecycle ----------------------------------------------------------

  cases.push({
    name: "a closed machine refuses, and closing it twice is what closing asked for",
    async run() {
      const sandbox = await open();
      got(await sandbox.close(), "close");
      // A hosted sandbox is billable, so a refusal to release is reported and
      // never swallowed — but a machine already gone is the requested state.
      got(await sandbox.close(), "close again");
      // Every method, not only the one: a caller that closed and kept a handle
      // has a bug, and it is worth the same answer whichever call exposes it.
      holds(!(await sandbox.exec({ command: "echo after" })).ok, "a closed sandbox does not run commands");
      holds(!(await sandbox.readFile({ path: "notes/one.md" })).ok, "nor read files");
      holds(!(await sandbox.writeFile({ path: "notes/one.md", content: "x" })).ok, "nor write them");
      holds(!(await sandbox.spawn({ command: ["echo", "after"] })).ok, "nor start processes");
    },
  });

  return cases;
}
