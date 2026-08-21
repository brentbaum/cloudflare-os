import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject, SELF } from "cloudflare:test";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_RELAY_CONNECTION_HEADER,
  type CodexRelayContract,
} from "@gadgets/workshop-shared/codex-relay";
import type { CodexAuth } from "../../src/vault.js";
import { MAX_INFERENCE_BODY_BYTES } from "../../src/policy.js";

type TestUpstreamControl = {
  reset(): Promise<void>;
  setInitialExpiresIn(seconds: number): Promise<void>;
  setExchangeMode(mode: "success" | "malformed" | "server-error"): Promise<void>;
  setRefreshMode(
    mode: "success" | "server-error" | "rate-limited" | "erroring-body",
  ): Promise<void>;
  setRefreshRetryAfter(seconds: number): Promise<void>;
  blockRefresh(): Promise<void>;
  releaseRefresh(): Promise<void>;
  rejectNextInferenceAsUnauthorized(): Promise<void>;
  setStreamMode(mode: "complete" | "cancellable" | "premature"): Promise<void>;
  configureSizedStream(totalBytes: number, chunkBytes: number): Promise<void>;
  waitForRefreshCalls(count: number): Promise<void>;
  waitForStreamCancellation(): Promise<void>;
  read(): Promise<{
    exchangeCalls: number;
    refreshCalls: number;
    inferenceCalls: number;
    streamCancellations: number;
    lastInferenceHeaders: Record<string, string>;
    lastInferenceBody: string;
    lastInferenceUrl: string;
    streamBytesProduced: number;
    streamBytesProducedAtHeaders: number;
    streamProductionCompletedAt: number;
    streamChunkBytes: number;
    streamMaxActivePulls: number;
  }>;
};

const testEnv = env as unknown as {
  CODEX_AUTH: DurableObjectNamespace<CodexAuth>;
  CODEX_RELAY: Fetcher & CodexRelayContract;
  CODEX_UPSTREAM: Fetcher & TestUpstreamControl;
};

const STATE_KEY = "codex-auth-state";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next });
  return { promise, resolve };
}

function inferenceRequest(signal?: AbortSignal): Request {
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
    signal,
  });
}

function relayInference(connection: string, request: Request): Promise<Response> {
  request.headers.set(CODEX_RELAY_CONNECTION_HEADER, connection);
  return testEnv.CODEX_RELAY.fetch(request);
}

async function zstdInferenceRequest(body: unknown): Promise<Request> {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const compressed = zstdCompressSync(encoded);
  return new Request("https://caller.invalid/backend-api/codex/responses", {
    method: "POST",
    headers: {
      "Content-Encoding": "zstd",
      "Content-Type": "application/json",
    },
    body: compressed,
  });
}

async function statusAfterConsume(responsePromise: Promise<Response>): Promise<number> {
  const response = await responsePromise;
  await response.arrayBuffer();
  return response.status;
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
  const authorization = await testEnv.CODEX_RELAY.startLogin(name);
  await forcePollDue(stub);
  const result = await testEnv.CODEX_RELAY.pollLogin(name, authorization.attemptId);
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
    await connect("single-flight", 0);
    await testEnv.CODEX_UPSTREAM.blockRefresh();

    const requests = Array.from({ length: 20 }, () =>
      relayInference("single-flight", inferenceRequest()),
    );
    await testEnv.CODEX_UPSTREAM.waitForRefreshCalls(1);
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);
    await testEnv.CODEX_UPSTREAM.releaseRefresh();

    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);
  });

  it("never lets a successful blocked refresh resurrect a disconnected connection", async () => {
    const name = "disconnect-during-refresh";
    await connect(name, 0);
    const before = await testEnv.CODEX_RELAY.status(name);
    await testEnv.CODEX_UPSTREAM.blockRefresh();

    const inference = statusAfterConsume(relayInference(name, inferenceRequest()));
    await testEnv.CODEX_UPSTREAM.waitForRefreshCalls(1);
    await testEnv.CODEX_RELAY.disconnect(name);
    const disconnected = await testEnv.CODEX_RELAY.status(name);
    expect(disconnected.state).toBe("disconnected");
    expect(disconnected.connectionEpoch).not.toBe(before.connectionEpoch);

    await testEnv.CODEX_UPSTREAM.releaseRefresh();
    await expect(inference).resolves.toBe(401);
    await expect(testEnv.CODEX_RELAY.status(name)).resolves.toEqual(disconnected);
  });

  it("never restores an old ready credential over a newer login after a refresh 429", async () => {
    const name = "login-during-rate-limited-refresh";
    await connect(name, 0);
    await testEnv.CODEX_UPSTREAM.blockRefresh();
    await testEnv.CODEX_UPSTREAM.setRefreshMode("rate-limited");

    const inference = statusAfterConsume(relayInference(name, inferenceRequest()));
    await testEnv.CODEX_UPSTREAM.waitForRefreshCalls(1);
    const newer = await testEnv.CODEX_RELAY.startLogin(name);
    await testEnv.CODEX_UPSTREAM.releaseRefresh();

    await expect(inference).resolves.toBe(401);
    await expect(testEnv.CODEX_RELAY.status(name)).resolves.toMatchObject({
      state: "pending",
      attemptId: newer.attemptId,
    });
  });

  it("rechecks refresh ownership after successful encryption before committing", async () => {
    const name = "login-during-refresh-encryption";
    const stub = await connect(name, 0);

    await runInDurableObject(stub, async (instance) => {
      const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      const encryptionStarted = deferred();
      const releaseEncryption = deferred();
      let encryptCalls = 0;
      const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
        encryptCalls++;
        if (encryptCalls === 1) {
          encryptionStarted.resolve();
          await releaseEncryption.promise;
        }
        return originalEncrypt(...args);
      });
      try {
        const inference = instance.infer(inferenceRequest());
        await encryptionStarted.promise;
        const newer = await instance.startLogin();
        releaseEncryption.resolve();

        await expect(statusAfterConsume(inference)).resolves.toBe(401);
        await expect(instance.status()).resolves.toMatchObject({
          state: "pending",
          attemptId: newer.attemptId,
        });
      } finally {
        releaseEncryption.resolve();
        encrypt.mockRestore();
      }
    });
  });

  it("does not replace disconnect when a refresh commit fails after dispatch", async () => {
    const name = "disconnect-during-refresh-commit";
    const stub = await connect(name, 0);
    const before = await stub.status();

    await runInDurableObject(stub, async (instance, state) => {
      const storage = state.storage as unknown as {
        put(key: string, value: unknown): Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      const commitStarted = deferred();
      const releaseCommit = deferred();
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (
          typeof value === "object" && value !== null && "state" in value &&
          value.state === "ready" && "generation" in value && value.generation === 2
        ) {
          commitStarted.resolve();
          await releaseCommit.promise;
          throw new Error("fake delayed refresh commit fault");
        }
        await originalPut(key, value);
      });
      try {
        const inference = instance.infer(inferenceRequest());
        await commitStarted.promise;
        await instance.disconnect();
        releaseCommit.resolve();

        await expect(statusAfterConsume(inference)).resolves.toBe(401);
        const disconnected = await instance.status();
        expect(disconnected.state).toBe("disconnected");
        expect(disconnected.connectionEpoch).not.toBe(before.connectionEpoch);
      } finally {
        releaseCommit.resolve();
        put.mockRestore();
      }
    });
  });

  it("does not replace a newer login when pending-secret decryption fails", async () => {
    const name = "login-during-pending-decryption";
    const stub = testEnv.CODEX_AUTH.getByName(name);
    const original = await stub.startLogin();
    await forcePollDue(stub);

    await runInDurableObject(stub, async (instance) => {
      const decryptionStarted = deferred();
      const releaseDecryption = deferred();
      const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async () => {
        decryptionStarted.resolve();
        await releaseDecryption.promise;
        throw new Error("fake delayed pending decryption fault");
      });
      try {
        const stalePoll = instance.pollLogin(original.attemptId);
        await decryptionStarted.promise;
        const newer = await instance.startLogin();
        releaseDecryption.resolve();

        await expect(stalePoll).resolves.toEqual({ state: "superseded" });
        await expect(instance.status()).resolves.toMatchObject({
          state: "pending",
          attemptId: newer.attemptId,
        });
      } finally {
        releaseDecryption.resolve();
        decrypt.mockRestore();
      }
    });
  });

  it("does not replace disconnect when credential decryption fails", async () => {
    const name = "disconnect-during-credential-decryption";
    const stub = await connect(name);
    const before = await stub.status();

    await runInDurableObject(stub, async (instance) => {
      const decryptionStarted = deferred();
      const releaseDecryption = deferred();
      const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async () => {
        decryptionStarted.resolve();
        await releaseDecryption.promise;
        throw new Error("fake delayed credential decryption fault");
      });
      try {
        const inference = instance.infer(inferenceRequest());
        await decryptionStarted.promise;
        await instance.disconnect();
        releaseDecryption.resolve();

        await expect(statusAfterConsume(inference)).resolves.toBe(401);
        const disconnected = await instance.status();
        expect(disconnected.state).toBe("disconnected");
        expect(disconnected.connectionEpoch).not.toBe(before.connectionEpoch);
      } finally {
        releaseDecryption.resolve();
        decrypt.mockRestore();
      }
    });
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
      state: "reauth-required",
      reason: "interrupted_refresh",
    });
    await expect(
      statusAfterConsume(relayInference("interrupted-marker", inferenceRequest())),
    ).resolves.toBe(401);
    expect((await testEnv.CODEX_UPSTREAM.read()).inferenceCalls).toBe(0);
  });

  it.each(["malformed", "server-error"] as const)(
    "makes a %s authorization-code exchange outcome terminal without re-exchange",
    async (mode) => {
      const name = `exchange-${mode}`;
      await testEnv.CODEX_UPSTREAM.setExchangeMode(mode);
      const stub = testEnv.CODEX_AUTH.getByName(name);
      const authorization = await testEnv.CODEX_RELAY.startLogin(name);
      await forcePollDue(stub);

      await expect(testEnv.CODEX_RELAY.pollLogin(name, authorization.attemptId)).resolves.toEqual({
        state: "failed",
        reconnectRequired: true,
      });
      await expect(testEnv.CODEX_RELAY.status(name)).resolves.toMatchObject({
        state: "reauth-required",
        reason: "authorization_code_exchange_failed",
      });
      await expect(testEnv.CODEX_RELAY.pollLogin(name, authorization.attemptId)).resolves.toEqual({
        state: "superseded",
      });
      expect((await testEnv.CODEX_UPSTREAM.read()).exchangeCalls).toBe(1);
    },
  );

  it("keeps the durable reconnect marker when initial credential encryption fails", async () => {
    const name = "exchange-encryption-fault";
    const stub = testEnv.CODEX_AUTH.getByName(name);
    const authorization = await testEnv.CODEX_RELAY.startLogin(name);
    await forcePollDue(stub);

    await runInDurableObject(stub, async (instance) => {
      const encrypt = vi
        .spyOn(crypto.subtle, "encrypt")
        .mockRejectedValueOnce(new Error("fake encryption fault"));
      try {
        await expect(instance.pollLogin(authorization.attemptId)).resolves.toEqual({
          state: "failed",
          reconnectRequired: true,
        });
      } finally {
        encrypt.mockRestore();
      }
    });

    await expect(testEnv.CODEX_RELAY.status(name)).resolves.toMatchObject({
      state: "reauth-required",
      reason: "credential_encryption_failed",
    });
    expect((await testEnv.CODEX_UPSTREAM.read()).exchangeCalls).toBe(1);
  });

  it("keeps the durable reconnect marker when the initial ready-state commit fails", async () => {
    const name = "exchange-commit-fault";
    const stub = testEnv.CODEX_AUTH.getByName(name);
    const authorization = await testEnv.CODEX_RELAY.startLogin(name);
    await forcePollDue(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const storage = state.storage as unknown as {
        put(key: string, value: unknown): Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "state" in value &&
          value.state === "ready"
        ) {
          throw new Error("fake ready commit fault");
        }
        await originalPut(key, value);
      });
      try {
        await expect(instance.pollLogin(authorization.attemptId)).resolves.toEqual({
          state: "failed",
          reconnectRequired: true,
        });
      } finally {
        put.mockRestore();
      }
    });

    await expect(testEnv.CODEX_RELAY.status(name)).resolves.toMatchObject({
      state: "reauth-required",
      reason: "credential_commit_failed",
    });
    expect((await testEnv.CODEX_UPSTREAM.read()).exchangeCalls).toBe(1);
  });

  it("requires reauthentication after an ambiguous refresh provider outcome", async () => {
    const name = "ambiguous-refresh";
    await connect(name, 0);
    await testEnv.CODEX_UPSTREAM.setRefreshMode("server-error");

    await expect(
      statusAfterConsume(relayInference(name, inferenceRequest())),
    ).resolves.toBe(401);
    await expect(testEnv.CODEX_RELAY.status(name)).resolves.toMatchObject({
      state: "reauth-required",
      reason: "ambiguous_refresh",
    });
  });

  it("fails closed without token reuse when a refresh error body cannot be read", async () => {
    const name = "refresh-erroring-body";
    await connect(name, 0);
    await testEnv.CODEX_UPSTREAM.setRefreshMode("erroring-body");

    await expect(
      statusAfterConsume(relayInference(name, inferenceRequest())),
    ).resolves.toBe(401);
    await expect(testEnv.CODEX_RELAY.status(name)).resolves.toMatchObject({
      state: "reauth-required",
      reason: "ambiguous_refresh",
    });
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);

    await expect(
      statusAfterConsume(relayInference(name, inferenceRequest())),
    ).resolves.toBe(401);
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);
  });

  it("persists a generation-scoped 429 cooldown and coalesces callers before retry", async () => {
    const name = "refresh-rate-limit-cooldown";
    const stub = await connect(name, 0);
    await testEnv.CODEX_UPSTREAM.setRefreshRetryAfter(999_999);
    await testEnv.CODEX_UPSTREAM.setRefreshMode("rate-limited");
    await testEnv.CODEX_UPSTREAM.blockRefresh();

    const coalescedPromise = Promise.all(
      Array.from({ length: 20 }, () => relayInference(name, inferenceRequest())),
    );
    await testEnv.CODEX_UPSTREAM.waitForRefreshCalls(1);
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);
    await testEnv.CODEX_UPSTREAM.releaseRefresh();
    const coalesced = await coalescedPromise;
    expect(coalesced.every((response) => response.status === 503)).toBe(true);
    expect(coalesced.every((response) => response.headers.get("retry-after") === "300")).toBe(true);
    await expect(coalesced[0]?.json()).resolves.toEqual({
      error: { code: "refresh_failed", message: "Codex authentication is unavailable" },
    });
    await Promise.all(coalesced.slice(1).map((response) => response.arrayBuffer()));

    const blocked = await Promise.all(
      Array.from({ length: 5 }, () => relayInference(name, inferenceRequest())),
    );
    expect(blocked.every((response) => response.status === 503)).toBe(true);
    expect(blocked.every((response) => response.headers.get("retry-after") === "300")).toBe(true);
    await Promise.all(blocked.map((response) => response.arrayBuffer()));
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);

    const persisted = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{
        generation: number;
        refreshRetry?: { generation: number; notBefore: number };
      }>(STATE_KEY),
    );
    expect(persisted?.refreshRetry).toMatchObject({ generation: persisted?.generation });
    expect((persisted?.refreshRetry?.notBefore ?? Infinity) - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1000,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const current = await state.storage.get<Record<string, unknown>>(STATE_KEY);
      if (!current) throw new Error("Missing rate-limited fake state");
      await state.storage.put(STATE_KEY, {
        ...current,
        refreshRetry: { generation: current.generation, notBefore: 0 },
      });
    });
    await testEnv.CODEX_UPSTREAM.setRefreshMode("success");

    const retried = await relayInference(name, inferenceRequest());
    expect(retried.status).toBe(200);
    await retried.arrayBuffer();
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(2);
  });

  it("reserves credential-state-unknown for local credential corruption", async () => {
    const name = "credential-corruption";
    const stub = await connect(name);
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get<{
        credential: { ciphertext: string };
      }>(STATE_KEY);
      if (!stored) throw new Error("Missing ready fake state");
      await state.storage.put(STATE_KEY, {
        ...stored,
        credential: { ...stored.credential, ciphertext: `${stored.credential.ciphertext}A` },
      });
    });

    await expect(
      statusAfterConsume(relayInference(name, inferenceRequest())),
    ).resolves.toBe(503);
    await expect(testEnv.CODEX_RELAY.status(name)).resolves.toMatchObject({
      state: "credential-state-unknown",
      reason: "credential_decryption_failed",
    });
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
    await connect("retry-once");
    await testEnv.CODEX_UPSTREAM.rejectNextInferenceAsUnauthorized();
    const response = await relayInference("retry-once", inferenceRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("request-workerd-fake-2");
    const upstream = await testEnv.CODEX_UPSTREAM.read();
    expect(upstream).toMatchObject({ refreshCalls: 1, inferenceCalls: 2 });
    expect(upstream.lastInferenceHeaders.authorization).not.toBe("Bearer caller-must-not-cross");
    expect(upstream.lastInferenceHeaders.cookie).toBeUndefined();
    expect(upstream.lastInferenceHeaders["chatgpt-account-id"]).toBe("account_workerd_fake");
    await response.arrayBuffer();
  });

  it("validates Pi zstd input with decompression bounds and forwards normalized identity JSON", async () => {
    await connect("zstd-input");
    const response = await relayInference(
      "zstd-input",
      await zstdInferenceRequest({
        model: "gpt-5.6-sol",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "fake zstd prompt" }] }],
      }),
    );
    expect(response.status).toBe(200);
    const upstream = await testEnv.CODEX_UPSTREAM.read();
    expect(upstream.lastInferenceUrl).toBe(
      "http://codex-egress.internal/backend-api/codex/responses",
    );
    expect(upstream.lastInferenceHeaders["content-encoding"]).toBeUndefined();
    expect(upstream.lastInferenceBody).toContain("fake zstd prompt");
    await expect(response.text()).resolves.toContain("fake-complete");

    const oversized = await zstdInferenceRequest({
      model: "gpt-5.6-sol",
      stream: true,
      input: "x".repeat(MAX_INFERENCE_BODY_BYTES + 1),
    });
    await expect(
      relayInference("zstd-bomb", oversized).then(async (result) => ({
        status: result.status,
        body: await result.json(),
      })),
    ).resolves.toMatchObject({
      status: 413,
      body: { error: { code: "request_too_large" } },
    });
  });

  it("returns an open upstream stream without buffering and permits downstream cancellation", async () => {
    await connect("stream-cancel");
    await testEnv.CODEX_UPSTREAM.setStreamMode("cancellable");
    const abort = new AbortController();
    const response = await relayInference(
      "stream-cancel",
      inferenceRequest(abort.signal),
    );
    const reader = response.body?.getReader();
    expect(await reader?.read()).toMatchObject({ done: false });
    await reader?.cancel();
    abort.abort("fake downstream cancellation");
    await Promise.race([
      testEnv.CODEX_UPSTREAM.waitForStreamCancellation(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for upstream cancellation")), 1_000),
      ),
    ]);
    expect((await testEnv.CODEX_UPSTREAM.read()).streamCancellations).toBe(1);
  });

  it.each([1 * 1024 * 1024, 50 * 1024 * 1024])(
    "streams %i bytes through both relay hops without full-body materialization",
    async (totalBytes) => {
      const name = `sized-stream-${totalBytes}`;
      const chunkBytes = totalBytes === 1024 * 1024 ? 256 * 1024 : 5 * 1024 * 1024;
      await connect(name);
      await testEnv.CODEX_UPSTREAM.configureSizedStream(totalBytes, chunkBytes);

      const response = await relayInference(name, inferenceRequest());
      const headersReceivedAt = Date.now();
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing sized fake response body");
      const first = await reader.read();
      const firstChunkReceivedAt = Date.now();
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBeLessThanOrEqual(chunkBytes);
      expect(first.value?.byteLength).toBeLessThan(totalBytes);
      let received = first.value?.byteLength ?? 0;
      while (received < totalBytes) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        expect(chunk.value?.byteLength).toBeLessThanOrEqual(chunkBytes);
        received += chunk.value?.byteLength ?? 0;
      }
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      expect(received).toBe(totalBytes);
      const metrics = await testEnv.CODEX_UPSTREAM.read();
      expect(metrics).toMatchObject({
        streamChunkBytes: chunkBytes,
        streamBytesProduced: totalBytes,
        streamBytesProducedAtHeaders: 0,
      });
      // No metrics RPC runs while the same-worker response stream is open: it can block behind the
      // active stream and perturb the measurement. These timestamps instead prove headers and the
      // first raw chunk arrived before the fixture finished production, so neither relay hop used
      // text(), json(), arrayBuffer(), or another full-body materialization. Actual queue depth and
      // RSS remain deployed-preview measurements rather than claims made by this local proxy.
      expect(headersReceivedAt).toBeLessThanOrEqual(metrics.streamProductionCompletedAt);
      expect(firstChunkReceivedAt).toBeLessThanOrEqual(metrics.streamProductionCompletedAt);
    },
    60_000,
  );

  it("preserves a premature SSE closure for downstream incomplete-stream classification", async () => {
    await connect("premature-stream");
    await testEnv.CODEX_UPSTREAM.setStreamMode("premature");
    const response = await relayInference("premature-stream", inferenceRequest());
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("data: fake-partial");
    await expect(reader?.read()).resolves.toEqual({ done: true, value: undefined });
    expect((await testEnv.CODEX_UPSTREAM.read()).streamCancellations).toBe(0);
  });

  it("keeps public HTTP dark and requires the private binding routing header", async () => {
    await expect(
      SELF.fetch("https://relay.invalid/").then((response) => response.status),
    ).resolves.toBe(404);
    await expect(
      testEnv.CODEX_RELAY.fetch(inferenceRequest()).then((response) => response.status),
    ).resolves.toBe(404);
    await expect(testEnv.CODEX_RELAY.status("rpc-connection")).resolves.toMatchObject({
      state: "disconnected",
    });
  });
});
