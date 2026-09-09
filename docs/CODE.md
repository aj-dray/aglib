# CODE — how the source is written and maintained

## Organization

One package. Folders and subpath exports are the boundaries; a companion package waits until a
vendor dependency or an independent release cadence forces the split.

```text
src/
  json.ts  result.ts  content.ts  agent.ts  run.ts  render.ts  terminal.ts
  session/    the log, its entries, and the projection to messages
  tools/      declaring and executing tools
  model/      the model port, its adapters, and the suite they answer
  store/      the store port, its adapters, and the suite they answer
  sandbox/    the containment port, its adapters, and the suite they answer
  harness/    the harness port and its adapters, our own loop among them
recipes/      the three applications that define the scope, one per answer to whose loop runs
```

A port whose contract is the same for every implementation ships `conformance.ts` beside it: an
inert list of named cases that throw, exported on its own subpath. `model`, `store` and `sandbox`
do. `harness` does not, and that is the distinction rather than an omission — what a harness must
prove depends on what it declares, so `recovery: "history"` and `recovery: "none"` do not answer one
list. Inert because the package must not carry a test framework — an adapter runs the cases under
whichever one it already has — and because a case that can be listed can also be skipped by name
when the thing it needs is not there.

`ARCHITECTURE.md` owns what each module means and the direction between them.

## Working posture

Greenfield until a public release. Prefer the best current shape over compatibility with an
accidental old one: replace bad contracts directly, with no aliases, deprecations, dual paths,
`legacy` folders, or shims. Do not preserve an implementation merely because it exists — and do
preserve proven logic that still fits the intended boundary.

Check facts about the outside world before asserting them. Model capabilities, provider APIs and
pricing move faster than any assistant's training data; if you cannot check, say the claim is
unverified rather than stating it flatly.

## Build the smallest complete thing

Start from the smallest useful consumer, give behaviour one clear owner, make dependencies explicit
in arguments, and use ordinary TypeScript composition before inventing a registry, plugin system,
policy language or lifecycle manager. Extract a shared abstraction after two real uses need the
same contract, and delete one nothing uses.

Minimal is not incomplete. Correct interruption, error, persistence and cleanup behaviour belong in
the first implementation when the feature claims those guarantees.

## API design

- Object parameters for public functions and port methods.
- `defineX` inert, `createX` stateful, `runX` immediate.
- Discriminated unions for protocols callers branch on; stable ids for replayable work.
- Untrusted boundaries validated from one runtime schema, with the TypeScript type derived from it.
- Anything crossing the JSON boundary is a **type alias, not an interface** — an interface has no
  index signature and cannot satisfy `JsonValue`. `CommandResult` is the worked example.
- Every export is public surface with a cost. An export no recipe composes is dead weight: give it
  a consumer or delete it. The gate enforces this.

## TypeScript

Follow `tsconfig.json`: strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, ESM.

Named exports only; type-only imports where required; relative imports carry their extension. No
`enum`, no `namespace`. Indexed access is possibly `undefined`. Domain JSON is camelCase;
timestamps are ISO 8601; identifiers and prose are American English.

Naming: `PascalCase` types, `camelCase` values, `isX` guards, kebab-case filenames, `noun.verb`
entry types.

Formatting: 2-space indentation, double quotes, semicolons, trailing commas in multiline structures.
Match the surrounding code; no formatter is configured.

## Errors and results

Expected outcomes callers must handle are data, not stringly typed exceptions.

`Result<T, E>` for recoverable outcomes, stable codes on every error, retryability only where the
caller can act on it, and never inspect error-message text to decide behaviour. Throws are for
programmer errors and violated invariants.

Model-visible output stays separate from structured application, UI and audit detail. A tool result
carries model-visible text and images in `content` and everything else in `details`, which never reaches the model.

## Tests

Validate contracts and failure modes without ossifying implementation detail. Prioritize state
transitions, ordering and idempotency, cancellation and interruption, transaction boundaries, and
permission-sensitive behaviour.

Hermetic: unit tests and recipe tests require no network, credentials or external service.

This file used to add that the fake model is a real implementation of the port, so a test against it
is a test against the contract every provider meets. That is the exact reasoning
`sandbox/conformance.ts` refuses — a fake proves only that the file calls the functions the file
calls — and holding both at once is how the model port ended up with three implementations, no
suite, and one adapter with no test file at all. The claim is gone and so is the gap it excused: the
fake now answers the same cases the wires do, and answering them is what says it is an
implementation.

A conformance suite against something real is the exception, and it stays hermetic by being skipped
by name rather than mocked. A fake daemon would prove only that the file calls the functions the
file calls; what needs proving is that a container answers the port the way a directory does, and
only a container can say. So the gate runs the Docker cases wherever the daemon and the image are
already there — no account, no network — and the ones that cost money or need a credential wait for
an explicit opt-in: `AGLIB_LIVE_MODEL=1` for the recipe cases that reach a provider,
`AGLIB_LIVE_ACP=1` for the ones that start a vendor's agent over `npx`. A skip prints what would
unlock it.

Compaction has an opt-in synthetic model eval: `bun scripts/eval-compaction.ts --model <OpenRouter ID> --output <new directory>`, with `OPENROUTER_API_KEY` in the environment. It compares unchanged history, summary-at-end ordering and chronological ordering using the same generated checkpoint, including a second fold. Add `--stress` to run two actual compaction-hook folds above a 553,200-token estimate instead. Neither mode executes tools. Requests, outcomes, checks and reported costs are saved under the output directory; the comparison is a small diagnostic, not a model ranking or proof of exhaustive retention. These paid calls are separate from the gate.

## The gate

`bun run check` covers typecheck, hermetic tests, the built package on Node, recipe types and tests,
generated reference freshness, and the invariants in `scripts/checks.ts`.

**A failing check is a decision, not an obstacle.** Fix the code, or change the check — deliberately,
in the same commit, with the reason in the message. If you find yourself writing a paragraph to
justify an exception, edit the script instead.

The checks are themselves tested, including that each fails loudly on empty input. A check that
cannot tell "nothing is wrong" from "I was not looking" is worse than none, because it is green
while blind.

## Releasing

The package is `@a-dray/aglib` on npm — the unscoped name is a lookalike of an existing package —
and `version` in `package.json` is the only place a version is written. A consumer aliases it so
imports stay `aglib`: `bun add aglib@npm:@a-dray/aglib@<version>`. A release is a commit that sets it, tagged `v<version>`, and `bun run release patch|minor|<version>`
on a clean, pushed `main` is the one way to write both: it runs the gate, commits the bump, tags,
and pushes. Pushing the tag runs `.github/workflows/publish.yml`, which refuses a tag that disagrees
with the manifest, runs the gate again, and publishes through npm's trusted publishing — the
workflow is the credential, so no token is held anywhere. Pre-1.0, a fix bumps the patch and a changed contract bumps the minor; there are no
deprecation aliases, so a consumer pins an exact version and moves on purpose.

## Comments and documents

Comments explain why, not what. Each surface owns its facts exactly once. Before adding a paragraph,
ask which document owns it — and first ask whether it can be a check instead, because a check fails
and prose does not.
