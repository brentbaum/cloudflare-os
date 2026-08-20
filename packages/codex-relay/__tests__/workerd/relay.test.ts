import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexRelayContract } from "@gadgets/workshop-shared/codex-relay";
import type { CodexAuth } from "../../src/vault.js";

type TestUpstreamControl = {
  reset(): Promise<void>;
  setInitialExpiresIn(seconds: number): Promise<void>;
  blockRefresh(): Promise<void>;
  releaseRefresh(): Promise<void>;
  rejectNextInferenceAsUnauthorized(): Promise<void>;
  setStreamMode(mode: "complete" | "cancellable"): Promise<void>;
  waitForRefreshCalls(count: number): Promise<void>;
  waitForStreamCancellation(): Promise<void>;
  read(): Promise<{
    refreshCalls: number;
    inferenceCalls: number;
    streamCancellations: number;
    lastInferenceHeaders: Record<string, string>;
  }>;
};

const testEnv = env as unknown as {
  CODEX_AUTH: DurableObjectNamespace<CodexAuth>;
  CODEX_RELAY: Fetcher & CodexRelayContract;
  CODEX_UPSTREAM: Fetcher & TestUpstreamControl;
};

const STATE_KEY = "codex-auth-state";

function inferenceRequest(): Request {
  return new Request("https://caller.invalid/backend-api/codex/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer caller-must-not-cross",
      Cookie: "caller-cookie-must-not-cross=fake",
      "ChatGPT-Account-Id": "caller-account-must-not-cross",
      "Content-Type": "application/json",
      Host: "caller-host-must-not-cross.invalid",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "fake prompt" }),
  });
}

async function forcePollDue(stub: DurableObjectStub<CodexAuth>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const stored = await state.storage.get<Record<string, unknown>>(STATE_KEY);
    if (!stored) throw new Error("Missing pending fake state");
    await state.storage.put(STATE_KEY, { ...stored, nextPollAt: 0 });
  });
}

async function connect(name: string, expiresIn = 3600): Promise<DurableObjectStub<CodexAuth>> {
  await testEnv.CODEX_UPSTREAM.setInitialExpiresIn(expiresIn);
  const stub = testEnv.CODEX_AUTH.getByName(name);
  const authorization = await stub.startLogin();
  await forcePollDue(stub);
  const result = await stub.pollLogin(authorization.attemptId);
  expect(result.state).toBe("ready");
  return stub;
}

describe("Codex relay in Workerd", () => {
  beforeEach(() => testEnv.CODEX_UPSTREAM.reset());

  afterEach(() => reset());

  it("encrypts pending and ready secrets at rest", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("encrypted-state");
    const authorization = await stub.startLogin();
    const pending = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>(STATE_KEY),
    );
    const pendingJson = JSON.stringify(pending);
    expect(pendingJson).toContain("ciphertext");
    expect(pendingJson).not.toContain("WORKERD-FAKE");
    expect(pendingJson).not.toContain("device_auth_workerd_fake");

    await forcePollDue(stub);
    await expect(stub.pollLogin(authorization.attemptId)).resolves.toMatchObject({
      state: "ready",
    });
    const ready = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>(STATE_KEY),
    );
    const readyJson = JSON.stringify(ready);
    expect(readyJson).toContain("ciphertext");
    expect(readyJson).not.toContain("refresh_workerd_fake");
    expect(readyJson).not.toContain("fake-header");
  });

  it("coalesces concurrent request-time refreshes behind one durable marker", async () => {
    const stub = await connect("single-flight", 0);
    await testEnv.CODEX_UPSTREAM.blockRefresh();

    const requests = Array.from({ length: 20 }, () => stub.infer(inferenceRequest()));
    await testEnv.CODEX_UPSTREAM.waitForRefreshCalls(1);
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);
    await testEnv.CODEX_UPSTREAM.releaseRefresh();

    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);
  });

  it("makes a new login authoritative and rejects stale attempt polls", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("latest-login-wins");
    const stale = await stub.startLogin();
    const current = await stub.startLogin();
    expect(current.attemptId).not.toBe(stale.attemptId);
    await expect(stub.pollLogin(stale.attemptId)).resolves.toEqual({ state: "superseded" });
    await forcePollDue(stub);
    await expect(stub.pollLogin(current.attemptId)).resolves.toMatchObject({ state: "ready" });
  });

  it("fails closed after reconstruction sees an interrupted refresh marker", async () => {
    let stub = await connect("interrupted-marker");
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get<Record<string, unknown>>(STATE_KEY);
      if (!stored) throw new Error("Missing ready fake state");
      await state.storage.put(STATE_KEY, {
        ...stored,
        refresh: {
          generation: stored.generation,
          attemptId: "attempt_interrupted_fake",
          startedAt: 1,
        },
      });
    });

    await abortAllDurableObjects();
    stub = testEnv.CODEX_AUTH.getByName("interrupted-marker");
    await expect(stub.status()).resolves.toMatchObject({
      state: "credential-state-unknown",
      reason: "interrupted_refresh",
    });
    await expect(stub.infer(inferenceRequest()).then((response) => response.status)).resolves.toBe(
      503,
    );
    expect((await testEnv.CODEX_UPSTREAM.read()).inferenceCalls).toBe(0);
  });

  it("disconnect erases ciphertext and rotates the connection epoch", async () => {
    const stub = await connect("disconnect");
    const before = await stub.status();
    await stub.disconnect();
    const after = await stub.status();
    expect(after.state).toBe("disconnected");
    expect(after.connectionEpoch).not.toBe(before.connectionEpoch);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>(STATE_KEY),
    );
    expect(JSON.stringify(stored)).not.toContain("ciphertext");
  });

  it("refreshes and retries exactly once on a pre-stream 401", async () => {
    const stub = await connect("retry-once");
    await testEnv.CODEX_UPSTREAM.rejectNextInferenceAsUnauthorized();
    const response = await stub.infer(inferenceRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("request-workerd-fake-2");
    const upstream = await testEnv.CODEX_UPSTREAM.read();
    expect(upstream).toMatchObject({ refreshCalls: 1, inferenceCalls: 2 });
    expect(upstream.lastInferenceHeaders.authorization).not.toBe("Bearer caller-must-not-cross");
    expect(upstream.lastInferenceHeaders.cookie).toBeUndefined();
    expect(upstream.lastInferenceHeaders["chatgpt-account-id"]).toBe("account_workerd_fake");
  });

  it("returns an open upstream stream without buffering and permits downstream cancellation", async () => {
    const stub = await connect("stream-cancel");
    await testEnv.CODEX_UPSTREAM.setStreamMode("cancellable");
    const response = await stub.infer(inferenceRequest());
    const reader = response.body?.getReader();
    expect(await reader?.read()).toMatchObject({ done: false });
    await reader?.cancel();
  });

  it("keeps the public Worker dark and exposes management only over RPC", async () => {
    await expect(
      SELF.fetch("https://relay.invalid/").then((response) => response.status),
    ).resolves.toBe(404);
    await expect(testEnv.CODEX_RELAY.status("rpc-connection")).resolves.toMatchObject({
      state: "disconnected",
    });
  });
});
