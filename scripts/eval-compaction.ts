import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { textOf } from "../src/content.js";
import { createCompactionHook, estimateTokens, summarize } from "../src/harness/adapters/native/compaction.js";
import type { HarnessContext } from "../src/harness/harness.js";
import { createOpenAiCompatibleModel } from "../src/model/adapters/openai-compatible/index.js";
import { collect, type Model, type ModelRequest } from "../src/model/model.js";
import type { Entry, Stored, Usage } from "../src/session/entry.js";
import { createLog } from "../src/session/log.js";
import { toMessages, type Message } from "../src/session/messages.js";

// Opt-in, synthetic continuation eval; no tools execute and no personal logs are used.
// bun scripts/eval-compaction.ts --model <OpenRouter model ID> --output /tmp/compaction-eval
const answerSchema = z.object({
  nextAction: z.enum(["research", "write", "send", "finish"]),
  nextTarget: z.string(),
  knownFact: z.string(),
  uncertainClaimVerified: z.boolean(),
  deliveredMessageId: z.string().nullable(),
  savedRecordId: z.string().nullable(),
  taskComplete: z.boolean(),
}).strict();
type Answer = z.infer<typeof answerSchema>;
type Variant = "uncompacted" | "legacy" | "corrected";
type Case = {
  id: string;
  prefix: readonly Entry[];
  correction: string;
  secondCorrection: string;
  expected: Answer;
  secondExpected: Answer;
};

const instructions = [
  "Continue the user's task from the conversation. No tools will execute in this evaluation.",
  "Return only one JSON object with these exact fields:",
  "nextAction: research | write | send | finish; nextTarget: exact company or record named by the user;",
  "knownFact: the exact project reference code; uncertainClaimVerified: whether the suspected contract has been verified;",
  "deliveredMessageId: the successful send's ID, or null; savedRecordId: the saved company record ID, or null;",
  "taskComplete: whether all requested work is complete.",
  "Describe the next action you would actually take, using observed outcomes to report current state.",
].join("\n");

const runId = "synthetic";
let callSequence = 0;
const user = (input: string): Entry => ({ type: "run.started", runId, input });
const assistant = (content: string): Entry => ({ type: "assistant", runId, content });
function tool(name: string, args: Record<string, string>, content: string, isError = false): Entry[] {
  const callId = `call-${++callSequence}`;
  return [
    { type: "assistant", runId, content: "", calls: [{ callId, name, arguments: JSON.stringify(args) }] },
    { type: "tool.finished", runId, callId, result: { content, ...(isError ? { isError } : {}) } },
  ];
}

// Padding is deliberately modest: this tests information loss and continuation, not maximum context capacity.
const padding = Array.from({ length: 12 }, (_, i) =>
  `Archive row ${i + 1}: legacy supplier directory reviewed; no new verified contract, record write, or delivery.`,
).join("\n");
const cases: Case[] = [
  {
    id: "people-discovery-correction",
    prefix: [
      user("Prepare the final supplier digest for Atlas Works. Project reference is AZ-417. Send the interim note first, then save Nox Services. A profile mentions Nox on the project; its current contract is unverified."),
      ...tool("send", { recipient: "owner", message: "Interim note AZ-417" }, "Delivered. Message ID: msg-731."),
      ...tool("company_write", { name: "Nox Services", recordId: "company-214" }, "Saved company record company-214."),
      assistant(padding),
      assistant("The final supplier digest for Atlas Works is still unfinished. Next I will finish that digest."),
    ],
    correction: "Change of task: pause the Atlas Works digest. Research people from Nox Services to discover unfamiliar employers. Do not resend the interim note. Continue now with Nox Services.",
    secondCorrection: "Change of priority again: research people from Cinder Systems next. Leave the digest pending. Continue now with Cinder Systems.",
    expected: { nextAction: "research", nextTarget: "Nox Services", knownFact: "AZ-417", uncertainClaimVerified: false, deliveredMessageId: "msg-731", savedRecordId: "company-214", taskComplete: false },
    secondExpected: { nextAction: "research", nextTarget: "Cinder Systems", knownFact: "AZ-417", uncertainClaimVerified: false, deliveredMessageId: "msg-731", savedRecordId: "company-214", taskComplete: false },
  },
  {
    id: "successful-send-failed-write",
    prefix: [
      user("Project reference TX-982. Save the discovered company then send an interim note. After that, research Summit Electric. A directory suggests Summit has the current contract; this has not been verified."),
      ...tool("company_write", { name: "Summit Electric", recordId: "company-909" }, "Validation failed: missing required company name. No record was saved.", true),
      ...tool("send", { recipient: "owner", message: "Interim note TX-982" }, "Delivered. Message ID: msg-846."),
      assistant(padding),
      assistant("I attempted the company save and sent the note. Next I will research Summit Electric."),
    ],
    correction: "Before further research, fix the failed save by writing the company named Summit Electric. The interim note is already delivered; do not send it again. Continue with the write now.",
    secondCorrection: "Use the corrected company name Summit Electrical Limited for that pending write. It is still not saved. Continue with the write now.",
    expected: { nextAction: "write", nextTarget: "Summit Electric", knownFact: "TX-982", uncertainClaimVerified: false, deliveredMessageId: "msg-846", savedRecordId: null, taskComplete: false },
    secondExpected: { nextAction: "write", nextTarget: "Summit Electrical Limited", knownFact: "TX-982", uncertainClaimVerified: false, deliveredMessageId: "msg-846", savedRecordId: null, taskComplete: false },
  },
];

function stored(entries: readonly Entry[], after = 0): Stored[] {
  return entries.map((entry, index) => ({ ...entry, seq: after + index + 1, at: "2026-01-01T00:00:00.000Z" }));
}

function projection(entries: readonly Stored[], variant: Variant): readonly Message[] {
  if (variant !== "legacy") return toMessages({ instructions, entries });
  // Keep the defective ordering confined to this comparison: the prefix summary
  // was appended after the retained tail because it was committed later.
  const latest = entries.findLast(entry => entry.type === "summary");
  if (!latest || latest.type !== "summary") throw new Error("Legacy comparison needs a summary");
  return [
    ...toMessages({ instructions, entries: entries.filter(entry => entry.seq > latest.replaces && entry.type !== "summary") }),
    { role: "user", content: `<summary>\n${latest.content}\n</summary>` },
  ];
}

function checksFor(answer: Answer | undefined, expected: Answer) {
  return {
    validJson: answer !== undefined,
    latestInstruction: answer?.nextAction === expected.nextAction && answer?.nextTarget === expected.nextTarget,
    earlierFact: answer?.knownFact === expected.knownFact,
    uncertainty: answer?.uncertainClaimVerified === expected.uncertainClaimVerified,
    successfulSendNotRepeated: answer?.deliveredMessageId === expected.deliveredMessageId && answer?.nextAction !== "send",
    writeOutcome: answer?.savedRecordId === expected.savedRecordId,
    unfinishedWork: answer?.taskComplete === expected.taskComplete,
  };
}

function archiveBatches(stage: number): Entry[] {
  const entries: Entry[] = [];
  for (let batch = 0; batch < 60; batch += 1) {
    const rows: string[] = [];
    let characters = 0;
    for (let row = 0; characters < 40_000; row += 1) {
      const line = `Synthetic archive ${stage}/${batch}/${row}: inventory bin ${batch * 1000 + row}; category ${row % 17}; old supplier directory row for Sample Workshop ${stage}-${batch}-${row}. Historical stock description only; no current contract evidence or operational action.\n`;
      rows.push(line);
      characters += line.length;
    }
    entries.push(...tool("archive_read", { path: `/synthetic/archive-${stage}-${batch}.txt` }, rows.join("")));
  }
  return entries;
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("OPENROUTER_API_KEY from environment; bun scripts/eval-compaction.ts --model <ID> --output <new directory> [--stress]\nDefault: 16 calls maximum, 60 seconds per call. Stress only: 4 calls, 120 seconds per call, about 600k estimated input tokens before each of two actual hook folds at 553200 tokens. Both: 10 minutes total; production summary output limit, 2000 output tokens per continuation. Synthetic fixtures only.");
    return;
  }
  const stress = args.length === 5 && args[4] === "--stress";
  if ((!stress && args.length !== 4) || args[0] !== "--model" || !args[1] || args[2] !== "--output" || !args[3]) {
    throw new Error("Usage: bun scripts/eval-compaction.ts --model <OpenRouter model ID> --output <new directory> [--stress]");
  }
  const modelId = args[1];
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set in the environment");
  const output = resolve(args[3]);
  await mkdir(output, { recursive: false });
  const save = (name: string, value: unknown) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n");
  await save("fixtures.json", { instructions, cases });
  const deadline = AbortSignal.timeout(10 * 60_000);
  const provider = createOpenAiCompatibleModel({ apiKey, model: modelId, baseUrl: "https://openrouter.ai/api/v1", effortParameter: "reasoning" });
  const calls: { name: string; usage?: Usage; elapsedMs: number; ok: boolean }[] = [];
  const evaluations: { case: string; stage: number; variant: Variant; checks: ReturnType<typeof checksFor>; usage: Usage }[] = [];
  const folds: { stage: number; beforeTokens: number; afterTokens: number; checkpoint: Stored }[] = [];
  let callName = "";
  const model: Model = {
    id: provider.id,
    async *generate(request: ModelRequest) {
      if (calls.length >= (stress ? 4 : 16) || deadline.aborted) throw new Error("Eval call/time limit reached");
      if (!request.maxOutputTokens || request.maxOutputTokens > 8_000) throw new Error("Eval requires at most 8000 output tokens per call");
      const name = `${String(calls.length + 1).padStart(2, "0")}-${callName}`;
      const started = Date.now();
      const record = { name, elapsedMs: 0, ok: false } as (typeof calls)[number];
      calls.push(record);
      const { signal: _signal, ...requestArtifact } = request;
      await save(`${name}-input.json`, requestArtifact);
      const result = await collect(provider.generate({
        ...request,
        signal: AbortSignal.any([deadline, AbortSignal.timeout(stress ? 120_000 : 60_000), ...(request.signal ? [request.signal] : [])]),
      }));
      record.elapsedMs = Date.now() - started;
      record.ok = result.ok;
      if (result.ok) record.usage = result.value.usage;
      await save(`${name}-result.json`, result);
      return result;
    },
  };

  async function makeSummary(entries: readonly Stored[], name: string) {
    callName = name;
    const result = await summarize({ model, messages: toMessages({ instructions, entries }), signal: deadline });
    if (!result.ok) throw new Error(`${name}: ${result.error.code}; see result artifact`);
    return result.value;
  }

  async function evaluate(test: Case, stage: number, variant: Variant, entries: readonly Stored[], expected: Answer) {
    callName = `${test.id}-${stage}-${variant}`;
    const result = await collect(model.generate({ messages: projection(entries, variant), maxOutputTokens: 2_000, signal: deadline }));
    if (!result.ok) throw new Error(`${callName}: ${result.error.code}; see result artifact`);
    let answer: Answer | undefined;
    try { answer = answerSchema.parse(JSON.parse(textOf(result.value.message.content))); } catch { /* A malformed response fails every applicable check. */ }
    const checks = checksFor(answer, expected);
    if (result.value.finishReason !== "stop" || result.value.message.calls?.length) checks.validJson = false;
    const evaluation = { case: test.id, stage, variant, checks, usage: result.value.usage };
    evaluations.push(evaluation);
    await save(`${callName}-checks.json`, { ...evaluation, expected, answer: answer ?? null });
    console.log(`${callName}: ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks`);
  }

  try {
    if (stress) {
      const test = { ...cases[1]!, id: "large-context-send-write" };
      const session = createLog(stored(test.prefix));
      const context: HarnessContext = {
        sessionId: "synthetic-stress", runId, instructions,
        entries: () => session.entries,
        history: () => toMessages({ instructions, entries: session.entries }),
        commit: async entries => { session.append(entries); },
        emit: () => {}, signal: deadline,
      };
      const hook = createCompactionHook({ model, maxInputTokens: 553_200 });
      for (const stage of [1, 2]) {
        const correction = stage === 1 ? test.correction : test.secondCorrection;
        session.append([...archiveBatches(stage), user(correction)]);
        const beforeTokens = estimateTokens(context.history());
        if (beforeTokens < 553_200 || beforeTokens > 700_000) throw new Error("Stress fixture is outside its intended input range");
        await save(`stress-${stage}-entries.json`, session.entries);
        const beforeSeq = session.seq;
        callName = `${test.id}-${stage}-summary`;
        const failure = await hook.beforeModel!(context);
        const checkpoint = session.entries.at(-1)!;
        const afterTokens = estimateTokens(context.history());
        await save(`stress-${stage}-fold.json`, { beforeTokens, afterTokens, failure: failure ?? null, committed: session.entries.filter(entry => entry.seq > beforeSeq) });
        if (failure) throw new Error(`Stress fold ${stage}: ${failure.code}; see fold artifact`);
        if (session.seq !== beforeSeq + 1 || checkpoint.type !== "summary") throw new Error("Stress hook did not commit exactly one checkpoint");
        if (context.history().at(-1)?.content !== correction) throw new Error("Stress fold lost the latest correction from its retained tail");
        folds.push({ stage, beforeTokens, afterTokens, checkpoint });
        console.log(`Stress fold ${stage}: ${Math.round(beforeTokens)} -> ${Math.round(afterTokens)} estimated tokens; folded through ${checkpoint.replaces}`);
        await evaluate(test, stage, "corrected", session.entries, stage === 1 ? test.expected : test.secondExpected);
      }
    } else for (const test of cases) {
      const prefix = stored(test.prefix);
      const tail = stored([user(test.correction)], prefix.length);
      const summary = await makeSummary(prefix, `${test.id}-1-summary`);
      const compacted = [...prefix, ...tail, ...stored([{ type: "summary", runId, content: summary, replaces: prefix.length }], prefix.length + tail.length)];
      await evaluate(test, 1, "uncompacted", [...prefix, ...tail], test.expected);
      await evaluate(test, 1, "legacy", compacted, test.expected);
      await evaluate(test, 1, "corrected", compacted, test.expected);

      // The second summary must carry the first summary and the newly folded
      // correction. Its append position is again after an even newer user turn.
      const secondSummary = await makeSummary(compacted, `${test.id}-2-summary`);
      const secondTail = stored([user(test.secondCorrection)], compacted.length);
      const twiceCompacted = [...compacted, ...secondTail, ...stored([{ type: "summary", runId, content: secondSummary, replaces: compacted.length }], compacted.length + secondTail.length)];
      await evaluate(test, 2, "uncompacted", [...prefix, ...tail, ...secondTail], test.secondExpected);
      await evaluate(test, 2, "legacy", twiceCompacted, test.secondExpected);
      await evaluate(test, 2, "corrected", twiceCompacted, test.secondExpected);
    }
  } finally {
    const usage: Usage = {};
    for (const call of calls) {
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
        const value = call.usage?.[key];
        if (value !== undefined) usage[key] = (usage[key] ?? 0) + value;
      }
    }
    const corrected = evaluations.filter(evaluation => evaluation.variant === "corrected");
    const expectedCount = stress ? 2 : 4;
    const passed = corrected.length === expectedCount && corrected.every(evaluation => Object.values(evaluation.checks).every(Boolean));
    await save("report.json", { model: modelId, mode: stress ? "stress" : "comparison", passed, calls, usage, costReportingComplete: calls.every(call => call.usage?.costUsd !== undefined), evaluations, ...(stress ? { folds } : {}) });
    console.log(`Corrected: ${corrected.filter(evaluation => Object.values(evaluation.checks).every(Boolean)).length}/${expectedCount} cases; calls: ${calls.length}; reported cost USD: ${usage.costUsd ?? "unavailable"}; artifacts: ${output}`);
    if (!passed) process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "Compaction eval failed");
    process.exitCode = 1;
  });
}
