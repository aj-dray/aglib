import { expect, test } from "bun:test";
import { retries, retrying } from "./retry.js";

/**
 * The waits themselves: how long, how many, and what ends them. The two HTTP
 * adapters prove separately that they are built on this; what is proved here
 * is the schedule, with the clock in hand so no case waits it out for real.
 */

type Answer = number | Error | { status: number; headers?: Record<string, string> };

/** A `fetch` scripted with one answer per attempt, whose waits are recorded rather than taken. */
function scripted(answers: readonly Answer[], options: { random?: number } = {}) {
  const waits: number[] = [];
  let attempts = 0;
  const call = (async (_input: unknown, _init?: RequestInit) => {
    const answer = answers[attempts];
    attempts += 1;
    if (answer === undefined) throw new Error("the script ran out of answers");
    if (answer instanceof Error) throw answer;
    const { status, headers } = typeof answer === "number" ? { status: answer, headers: undefined } : answer;
    return new Response(status === 204 ? null : "body", { status, ...(headers ? { headers } : {}) });
  }) as unknown as typeof fetch;
  const wrapped = retrying(call, {
    sleep: async (ms) => { waits.push(ms); },
    random: () => options.random ?? 1,
  });
  return { call: wrapped, waits, attempts: () => attempts };
}

test("a wait is asked again, and the answer that follows is the one returned", async () => {
  const wire = scripted([429, 503, 200]);
  const response = await wire.call("https://api.example.test/v1");
  expect(response.status).toBe(200);
  expect(wire.attempts()).toBe(3);
  // Full jitter over a doubling ceiling: with the die pinned at its maximum,
  // the ceilings themselves.
  expect(wire.waits).toEqual([1_000, 2_000]);
});

test("Retry-After is waited, as seconds or as a date, and no longer than two minutes", async () => {
  const soon = new Date(Date.now() + 5_000).toUTCString();
  const wire = scripted([
    { status: 429, headers: { "retry-after": "2" } },
    { status: 429, headers: { "retry-after": soon } },
    { status: 429, headers: { "retry-after": "3600" } },
    200,
  ]);
  await wire.call("https://api.example.test/v1");
  expect(wire.waits[0]).toBe(2_000);
  expect(wire.waits[1]).toBeGreaterThan(3_000);
  expect(wire.waits[1]).toBeLessThanOrEqual(5_000);
  expect(wire.waits[2]).toBe(120_000);
});

test("the retries run out, and the last answer is handed back unchanged", async () => {
  const wire = scripted(Array.from({ length: retries + 1 }, () => ({ status: 503, headers: { "retry-after": "0" } })));
  const response = await wire.call("https://api.example.test/v1");
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("body");
  expect(wire.attempts()).toBe(retries + 1);
});

test("a transport error is a wait too, and the last one is thrown", async () => {
  const recovered = scripted([new Error("connection reset"), 200]);
  expect((await recovered.call("https://api.example.test/v1")).status).toBe(200);

  const dead = scripted(Array.from({ length: retries + 1 }, () => new Error("connection reset")));
  await expect(dead.call("https://api.example.test/v1")).rejects.toThrow("connection reset");
  expect(dead.attempts()).toBe(retries + 1);
});

test("waiting stops once three minutes of it would be spent", async () => {
  const wire = scripted([
    { status: 429, headers: { "retry-after": "120" } },
    { status: 429, headers: { "retry-after": "120" } },
    200,
  ]);
  const response = await wire.call("https://api.example.test/v1");
  // The second wait would take the total past the bound, so the second answer
  // is the one returned — and the provider's, not one invented here.
  expect(response.status).toBe(429);
  expect(wire.attempts()).toBe(2);
  expect(wire.waits).toEqual([120_000]);
});

test("a refusal is not asked again", async () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422]) {
    const wire = scripted([status, 200]);
    expect((await wire.call("https://api.example.test/v1")).status).toBe(status);
    expect(wire.attempts()).toBe(1);
  }
});

test("an endpoint's own word for a wait is asked for only where the status did not decide", async () => {
  const asked: number[] = [];
  const answers = [402, 402, 200];
  let attempts = 0;
  const call = (async () => new Response("{\"error\":{\"metadata\":{\"reason\":\"in_flight\"}}}", {
    status: answers[attempts++]!, headers: { "retry-after": "0" },
  })) as unknown as typeof fetch;
  const wrapped = retrying(call, {
    isWait: async (response) => {
      asked.push(response.status);
      const body = await response.clone().json() as { error: { metadata: { reason: string } } };
      return body.error.metadata.reason === "in_flight";
    },
    sleep: async () => {},
  });
  expect((await wrapped("https://api.example.test/v1")).status).toBe(200);
  expect(asked).toEqual([402, 402]);
});

test("an abort ends a wait at once, as the abort it is", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const call = (async () => {
    attempts += 1;
    return new Response("body", { status: 429, headers: { "retry-after": "30" } });
  }) as unknown as typeof fetch;
  const wrapped = retrying(call);
  const pending = wrapped("https://api.example.test/v1", { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(attempts).toBe(1);
});
