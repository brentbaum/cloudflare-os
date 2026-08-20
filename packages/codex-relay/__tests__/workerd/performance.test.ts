import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexRelayContract } from "@gadgets/workshop-shared/codex-relay";
import type { CodexAuth } from "../../src/vault.js";

type TestUpstreamPerformanceControl = {
  reset(): Promise<void>;
  setStreamMode(mode: "cancellable" | "timed"): Promise<void>;
  clearPerformanceSamples(): Promise<void>;
  waitForStreamCancellation(): Promise<void>;
  readPerformanceSamples(): Promise<{
    firstByteTimestamps: number[];
    cancellationTimestamps: number[];
  }>;
};

const testEnv = env as unknown as {
  CODEX_AUTH: DurableObjectNamespace<CodexAuth>;
  CODEX_RELAY: Fetcher & CodexRelayContract;
  CODEX_UPSTREAM: Fetcher & TestUpstreamPerformanceControl;
};

const STATE_KEY = "codex-auth-state";

function inferenceRequest(signal?: AbortSignal): Request {
  return new Request("https://caller.invalid/backend-api/codex/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "fake perf prompt" }),
    signal,
  });
}

async function connect(name: string): Promise<void> {
  const stub = testEnv.CODEX_AUTH.getByName(name);
  const authorization = await testEnv.CODEX_RELAY.startLogin(name);
  await runInDurableObject(stub, async (_instance, state) => {
    const stored = await state.storage.get<Record<string, unknown>>(STATE_KEY);
    if (!stored) throw new Error("Missing pending fake state");
    await state.storage.put(STATE_KEY, { ...stored, nextPollAt: 0 });
  });
  const result = await testEnv.CODEX_RELAY.pollLogin(name, authorization.attemptId);
  expect(result.state).toBe("ready");
}

async function consumeTimedFirstByte(name: string): Promise<number> {
  const response = await testEnv.CODEX_RELAY.infer(name, inferenceRequest());
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing timed fake response body");
  expect(await reader.read()).toMatchObject({ done: false });
  const receivedAt = Date.now();
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  return receivedAt;
}

function percentile95(values: number[]): number {
  // eslint-disable-next-line unicorn/no-array-sort -- package target predates Array#toSorted.
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
}

describe("Codex relay local performance proxies", () => {
  beforeEach(() => testEnv.CODEX_UPSTREAM.reset());
  afterEach(() => reset());

  it("keeps warm local first-byte relay overhead within 250ms at p95 over 100 paths", async () => {
    const name = "local-first-byte-proxy";
    await connect(name);
    await testEnv.CODEX_UPSTREAM.setStreamMode("timed");

    for (let index = 0; index < 5; index++) await consumeTimedFirstByte(name);
    await testEnv.CODEX_UPSTREAM.clearPerformanceSamples();

    const receivedAt: number[] = [];
    for (let index = 0; index < 100; index++) receivedAt.push(await consumeTimedFirstByte(name));
    const { firstByteTimestamps } = await testEnv.CODEX_UPSTREAM.readPerformanceSamples();
    expect(firstByteTimestamps).toHaveLength(100);
    const overheads = receivedAt.map((timestamp, index) =>
      timestamp - (firstByteTimestamps[index] ?? Infinity)
    );
    expect(overheads.every((overhead) => overhead >= 0)).toBe(true);
    expect(percentile95(overheads)).toBeLessThanOrEqual(250);
  }, 30_000);

  it("observes caller abort at the fake upstream within 500ms", async () => {
    const name = "local-cancel-latency-proxy";
    await connect(name);
    await testEnv.CODEX_UPSTREAM.setStreamMode("cancellable");
    const abort = new AbortController();
    const response = await testEnv.CODEX_RELAY.infer(name, inferenceRequest(abort.signal));
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing cancellable fake response body");
    expect(await reader.read()).toMatchObject({ done: false });

    const abortedAt = Date.now();
    abort.abort("fake local cancellation timing");
    // Match the AgentOS transport bridge: after response headers, abort cancels the response body
    // rather than tearing down the already-resolved RPC invocation through a second signal path.
    await reader.cancel("fake local cancellation timing");
    await Promise.race([
      testEnv.CODEX_UPSTREAM.waitForStreamCancellation(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for upstream cancellation")), 1_000),
      ),
    ]);
    const { cancellationTimestamps } = await testEnv.CODEX_UPSTREAM.readPerformanceSamples();
    const cancellationAt = cancellationTimestamps.at(-1);
    expect(cancellationAt).toBeTypeOf("number");
    expect((cancellationAt ?? Infinity) - abortedAt).toBeGreaterThanOrEqual(0);
    expect((cancellationAt ?? Infinity) - abortedAt).toBeLessThan(500);
  });
});
