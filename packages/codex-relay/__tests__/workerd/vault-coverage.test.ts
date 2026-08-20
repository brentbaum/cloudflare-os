import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexRelayContract } from "@gadgets/workshop-shared/codex-relay";
import type { CodexAuth } from "../../src/vault.js";

type TestUpstreamControl = {
  reset(): Promise<void>;
  setInitialExpiresIn(seconds: number): Promise<void>;
  setDeviceStartMode(mode: "success" | "server-error"): Promise<void>;
  setDevicePollMode(
    mode: "authorized" | "denied" | "expired" | "pending" | "rate-limited",
  ): Promise<void>;
  setExchangeMode(mode: "success" | "malformed" | "server-error"): Promise<void>;
  blockDeviceStart(): Promise<void>;
  releaseDeviceStart(): Promise<void>;
  blockDevicePoll(): Promise<void>;
  releaseDevicePoll(): Promise<void>;
  blockExchange(): Promise<void>;
  releaseExchange(): Promise<void>;
  waitForDeviceStartCalls(count: number): Promise<void>;
  waitForDevicePollCalls(count: number): Promise<void>;
  waitForExchangeCalls(count: number): Promise<void>;
  setRefreshMode(mode: "success" | "server-error" | "rate-limited"): Promise<void>;
  blockRefresh(): Promise<void>;
  releaseRefresh(): Promise<void>;
  waitForRefreshCalls(count: number): Promise<void>;
};

const testEnv = env as unknown as {
  CODEX_AUTH: DurableObjectNamespace<CodexAuth>;
  CODEX_RELAY: Fetcher & CodexRelayContract;
  CODEX_UPSTREAM: Fetcher & TestUpstreamControl;
};

const STATE_KEY = "codex-auth-state";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next });
  return { promise, resolve };
}

function inferenceRequest(): Request {
  return new Request("https://caller.invalid/backend-api/codex/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "fake vault coverage" }),
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
  await expect(stub.pollLogin(authorization.attemptId)).resolves.toMatchObject({ state: "ready" });
  return stub;
}

async function responseStatus(responsePromise: Promise<Response>): Promise<number> {
  const response = await responsePromise;
  await response.arrayBuffer();
  return response.status;
}

describe("Codex vault branch coverage", () => {
  beforeEach(() => testEnv.CODEX_UPSTREAM.reset());
  afterEach(() => reset());

  it("projects starting and unsupported-version states without secrets", async () => {
    const starting = testEnv.CODEX_AUTH.getByName("status-starting");
    await runInDurableObject(starting, async (instance, state) => {
      await state.storage.put(STATE_KEY, {
        version: 1,
        state: "starting",
        connectionEpoch: "epoch_starting_fake",
        attemptId: "attempt_starting_fake",
        expiresAt: 100,
        nextPollAt: 50,
      });
      await expect(instance.status()).resolves.toMatchObject({
        state: "pending",
        attemptId: "attempt_starting_fake",
      });
    });

    const unsupported = testEnv.CODEX_AUTH.getByName("status-unsupported-version");
    await runInDurableObject(unsupported, async (instance, state) => {
      await state.storage.put(STATE_KEY, { version: 0, state: "disconnected" });
      await expect(instance.status()).resolves.toMatchObject({
        state: "credential-state-unknown",
        reason: "unsupported_state_version",
      });
    });
  });

  it("rolls back an owned device-start failure", async () => {
    await testEnv.CODEX_UPSTREAM.setDeviceStartMode("server-error");
    const stub = testEnv.CODEX_AUTH.getByName("device-start-failure");
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.startLogin()).rejects.toThrow();
    });
    await expect(stub.status()).resolves.toMatchObject({ state: "disconnected" });
  });

  it("does not roll back a newer state after a delayed device-start failure", async () => {
    await testEnv.CODEX_UPSTREAM.setDeviceStartMode("server-error");
    await testEnv.CODEX_UPSTREAM.blockDeviceStart();
    const stub = testEnv.CODEX_AUTH.getByName("device-start-failure-race");
    await runInDurableObject(stub, async (instance) => {
      const login = instance.startLogin();
      await testEnv.CODEX_UPSTREAM.waitForDeviceStartCalls(1);
      await instance.disconnect();
      await testEnv.CODEX_UPSTREAM.releaseDeviceStart();
      await expect(login).rejects.toThrow();
      await expect(instance.status()).resolves.toMatchObject({ state: "disconnected" });
    });
  });

  it("rejects login supersession after provider response and after pending encryption", async () => {
    await testEnv.CODEX_UPSTREAM.blockDeviceStart();
    const providerStub = testEnv.CODEX_AUTH.getByName("device-start-success-race");
    await runInDurableObject(providerStub, async (instance) => {
      const login = instance.startLogin();
      await testEnv.CODEX_UPSTREAM.waitForDeviceStartCalls(1);
      await instance.disconnect();
      await testEnv.CODEX_UPSTREAM.releaseDeviceStart();
      await expect(login).rejects.toThrow("superseded");
    });

    const encryptionStub = testEnv.CODEX_AUTH.getByName("pending-encryption-race");
    await runInDurableObject(encryptionStub, async (instance) => {
      const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      const started = deferred();
      const release = deferred();
      const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return originalEncrypt(...args);
      });
      try {
        const login = instance.startLogin();
        await started.promise;
        await instance.disconnect();
        release.resolve();
        await expect(login).rejects.toThrow("superseded");
      } finally {
        release.resolve();
        encrypt.mockRestore();
      }
    });
  });

  it("covers local expiry, provider pacing, denial, and expiry poll transitions", async () => {
    const early = testEnv.CODEX_AUTH.getByName("poll-early");
    const earlyLogin = await early.startLogin();
    await expect(early.pollLogin(earlyLogin.attemptId)).resolves.toMatchObject({ state: "pending" });
    await runInDurableObject(early, async (instance, state) => {
      const stored = await state.storage.get<Record<string, unknown>>(STATE_KEY);
      await state.storage.put(STATE_KEY, { ...stored, expiresAt: 0 });
      await expect(instance.pollLogin(earlyLogin.attemptId)).resolves.toEqual({ state: "expired" });
    });

    for (const mode of ["pending", "rate-limited"] as const) {
      await testEnv.CODEX_UPSTREAM.setDevicePollMode(mode);
      const stub = testEnv.CODEX_AUTH.getByName(`poll-${mode}`);
      const login = await stub.startLogin();
      await forcePollDue(stub);
      await expect(stub.pollLogin(login.attemptId)).resolves.toMatchObject({ state: "pending" });
    }
    for (const mode of ["denied", "expired"] as const) {
      await testEnv.CODEX_UPSTREAM.setDevicePollMode(mode);
      const stub = testEnv.CODEX_AUTH.getByName(`poll-${mode}`);
      const login = await stub.startLogin();
      await forcePollDue(stub);
      await expect(stub.pollLogin(login.attemptId)).resolves.toEqual({ state: mode });
      await expect(stub.status()).resolves.toMatchObject({ state: "disconnected" });
    }
  });

  it("makes a newer login authoritative while device polling or exchange is blocked", async () => {
    await testEnv.CODEX_UPSTREAM.blockDevicePoll();
    const pollStub = testEnv.CODEX_AUTH.getByName("poll-provider-race");
    const pollLogin = await pollStub.startLogin();
    await forcePollDue(pollStub);
    const poll = pollStub.pollLogin(pollLogin.attemptId);
    await testEnv.CODEX_UPSTREAM.waitForDevicePollCalls(1);
    const newerPollLogin = await pollStub.startLogin();
    await testEnv.CODEX_UPSTREAM.releaseDevicePoll();
    await expect(poll).resolves.toEqual({ state: "superseded" });
    await expect(pollStub.status()).resolves.toMatchObject({ attemptId: newerPollLogin.attemptId });

    await testEnv.CODEX_UPSTREAM.blockExchange();
    const exchangeStub = testEnv.CODEX_AUTH.getByName("exchange-provider-race");
    const exchangeLogin = await exchangeStub.startLogin();
    await forcePollDue(exchangeStub);
    const exchange = exchangeStub.pollLogin(exchangeLogin.attemptId);
    await testEnv.CODEX_UPSTREAM.waitForExchangeCalls(1);
    const newerExchangeLogin = await exchangeStub.startLogin();
    await testEnv.CODEX_UPSTREAM.releaseExchange();
    await expect(exchange).resolves.toEqual({ state: "superseded" });
    await expect(exchangeStub.status()).resolves.toMatchObject({
      attemptId: newerExchangeLogin.attemptId,
    });
  });

  it("keeps a newer state when failed credential encryption loses ownership", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("exchange-encryption-failure-race");
    const login = await stub.startLogin();
    await forcePollDue(stub);
    await runInDurableObject(stub, async (instance) => {
      const started = deferred();
      const release = deferred();
      const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        throw new Error("fake delayed credential encryption failure");
      });
      try {
        const poll = instance.pollLogin(login.attemptId);
        await started.promise;
        await instance.disconnect();
        release.resolve();
        await expect(poll).resolves.toEqual({ state: "superseded" });
      } finally {
        release.resolve();
        encrypt.mockRestore();
      }
    });
  });

  it("fails closed when the owned pending secret cannot be decrypted", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("pending-decryption-failure-owned");
    const login = await stub.startLogin();
    await forcePollDue(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const stored = await state.storage.get<{
        pending: { ciphertext: string };
      }>(STATE_KEY);
      if (!stored) throw new Error("Missing pending fake state");
      await state.storage.put(STATE_KEY, {
        ...stored,
        pending: { ...stored.pending, ciphertext: `${stored.pending.ciphertext}A` },
      });
      await expect(instance.pollLogin(login.attemptId)).rejects.toThrow("credential_state_unknown");
      await expect(instance.status()).resolves.toMatchObject({
        state: "credential-state-unknown",
        reason: "pending_state_decryption_failed",
      });
    });
  });

  it("does not poll after successful pending decryption loses ownership", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("pending-decryption-success-race");
    const login = await stub.startLogin();
    await forcePollDue(stub);
    await runInDurableObject(stub, async (instance) => {
      const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      const started = deferred();
      const release = deferred();
      const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
        const result = await originalDecrypt(...args);
        started.resolve();
        await release.promise;
        return result;
      });
      try {
        const poll = instance.pollLogin(login.attemptId);
        await started.promise;
        await instance.disconnect();
        release.resolve();
        await expect(poll).resolves.toEqual({ state: "superseded" });
      } finally {
        release.resolve();
        decrypt.mockRestore();
      }
    });
  });

  it("does not refine an exchange failure after a newer state takes ownership", async () => {
    await testEnv.CODEX_UPSTREAM.setExchangeMode("server-error");
    await testEnv.CODEX_UPSTREAM.blockExchange();
    const stub = testEnv.CODEX_AUTH.getByName("exchange-failure-ownership-race");
    const login = await stub.startLogin();
    await forcePollDue(stub);
    const poll = stub.pollLogin(login.attemptId);
    await testEnv.CODEX_UPSTREAM.waitForExchangeCalls(1);
    await stub.disconnect();
    await testEnv.CODEX_UPSTREAM.releaseExchange();
    await expect(poll).resolves.toEqual({ state: "superseded" });
    await expect(stub.status()).resolves.toMatchObject({ state: "disconnected" });
  });

  it("does not commit a credential after successful encryption loses ownership", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("exchange-encryption-success-race");
    const login = await stub.startLogin();
    await forcePollDue(stub);
    await runInDurableObject(stub, async (instance) => {
      const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      const started = deferred();
      const release = deferred();
      const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
        const result = await originalEncrypt(...args);
        started.resolve();
        await release.promise;
        return result;
      });
      try {
        const poll = instance.pollLogin(login.attemptId);
        await started.promise;
        await instance.disconnect();
        release.resolve();
        await expect(poll).resolves.toEqual({ state: "superseded" });
      } finally {
        release.resolve();
        encrypt.mockRestore();
      }
    });
  });

  it("retains the terminal exchange marker if commit diagnostics also fail", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("initial-commit-diagnostic-failure");
    const login = await stub.startLogin();
    await forcePollDue(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const storage = state.storage as unknown as {
        put(key: string, value: unknown): Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (typeof value === "object" && value !== null && "state" in value) {
          if (value.state === "ready") throw new Error("fake initial ready commit failure");
          if (value.state === "reauth-required" && "reason" in value &&
            value.reason === "credential_commit_failed")
            throw new Error("fake initial diagnostic persistence failure");
        }
        await originalPut(key, value);
      });
      try {
        await expect(instance.pollLogin(login.attemptId)).resolves.toEqual({
          state: "failed",
          reconnectRequired: true,
        });
      } finally {
        put.mockRestore();
      }
    });
    await expect(stub.status()).resolves.toMatchObject({
      state: "reauth-required",
      reason: "authorization_code_exchange_in_progress",
    });
  });

  it("returns sanitized generic and disconnected inference failures", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("generic-inference-failure");
    await runInDurableObject(stub, async (instance) => {
      const arrayBuffer = vi.spyOn(Request.prototype, "arrayBuffer").mockRejectedValueOnce(
        new Error("secret fake parser failure"),
      );
      try {
        const generic = await instance.infer(inferenceRequest());
        expect(generic.status).toBe(503);
        await expect(generic.text()).resolves.not.toContain("secret fake parser failure");
      } finally {
        arrayBuffer.mockRestore();
      }
      const disconnected = await instance.infer(inferenceRequest());
      expect(disconnected.status).toBe(401);
      await disconnected.arrayBuffer();
    });
  });

  it("does not retry a 401 when that request already refreshed", async () => {
    const name = "refreshed-request-401";
    await connect(name, 0);
    await (testEnv.CODEX_UPSTREAM as unknown as {
      rejectNextInferenceAsUnauthorized(): Promise<void>;
    }).rejectNextInferenceAsUnauthorized();
    const response = await testEnv.CODEX_RELAY.infer(name, inferenceRequest());
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  });

  it("projects credential-state-unknown through inference", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("credential-state-unknown-inference");
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put(STATE_KEY, {
        version: 1,
        state: "credential-state-unknown",
        connectionEpoch: "epoch_unknown_fake",
        reason: "credential_commit_failed",
      });
      await expect(responseStatus(instance.infer(inferenceRequest()))).resolves.toBe(503);
    });
  });

  it("does not begin refresh after successful credential decryption loses ownership", async () => {
    const stub = await connect("refresh-before-marker-race", 0);
    await runInDurableObject(stub, async (instance) => {
      const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      const started = deferred();
      const release = deferred();
      const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
        const result = await originalDecrypt(...args);
        started.resolve();
        await release.promise;
        return result;
      });
      try {
        const inference = instance.infer(inferenceRequest());
        await started.promise;
        await instance.disconnect();
        release.resolve();
        await expect(responseStatus(inference)).resolves.toBe(401);
        await expect(instance.status()).resolves.toMatchObject({ state: "disconnected" });
      } finally {
        release.resolve();
        decrypt.mockRestore();
      }
    });
  });

  it("joins a refresh installed while another caller is decrypting", async () => {
    const stub = await connect("refresh-second-single-flight-check", 0);
    await testEnv.CODEX_UPSTREAM.blockRefresh();
    await runInDurableObject(stub, async (instance) => {
      const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      const started = deferred();
      const release = deferred();
      const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
        const result = await originalDecrypt(...args);
        started.resolve();
        await release.promise;
        return result;
      });
      try {
        const first = instance.infer(inferenceRequest());
        await started.promise;
        const second = instance.infer(inferenceRequest());
        await testEnv.CODEX_UPSTREAM.waitForRefreshCalls(1);
        release.resolve();
        await testEnv.CODEX_UPSTREAM.releaseRefresh();
        await expect(Promise.all([responseStatus(first), responseStatus(second)])).resolves.toEqual([
          200,
          200,
        ]);
      } finally {
        release.resolve();
        await testEnv.CODEX_UPSTREAM.releaseRefresh();
        decrypt.mockRestore();
      }
    });
  });

  it("fails closed when refresh credential encryption fails while still owned", async () => {
    const stub = await connect("refresh-encryption-failure", 0);
    await runInDurableObject(stub, async (instance) => {
      const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(
        new Error("fake refresh encryption failure"),
      );
      try {
        await expect(responseStatus(instance.infer(inferenceRequest()))).resolves.toBe(503);
        await expect(instance.status()).resolves.toMatchObject({
          state: "credential-state-unknown",
          reason: "refresh_encryption_failed",
        });
      } finally {
        encrypt.mockRestore();
      }
    });
  });

  it("does not replace disconnect after delayed refresh encryption failure", async () => {
    const stub = await connect("refresh-encryption-failure-race", 0);
    await runInDurableObject(stub, async (instance) => {
      const started = deferred();
      const release = deferred();
      const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        throw new Error("fake delayed refresh encryption failure");
      });
      try {
        const inference = instance.infer(inferenceRequest());
        await started.promise;
        await instance.disconnect();
        release.resolve();
        await expect(responseStatus(inference)).resolves.toBe(401);
        await expect(instance.status()).resolves.toMatchObject({ state: "disconnected" });
      } finally {
        release.resolve();
        encrypt.mockRestore();
      }
    });
  });

  it("accepts a refresh commit that persisted before storage reported failure", async () => {
    const stub = await connect("refresh-commit-readback-success", 0);
    await runInDurableObject(stub, async (instance, state) => {
      const storage = state.storage as unknown as {
        put(key: string, value: unknown): Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (
          typeof value === "object" && value !== null && "state" in value &&
          value.state === "ready" && "generation" in value && value.generation === 2
        ) {
          await originalPut(key, value);
          throw new Error("fake post-commit storage failure");
        }
        await originalPut(key, value);
      });
      try {
        await expect(responseStatus(instance.infer(inferenceRequest()))).resolves.toBe(200);
        const stored = await state.storage.get<{ generation: number }>(STATE_KEY);
        expect(stored?.generation).toBe(2);
      } finally {
        put.mockRestore();
      }
    });
  });

  it("records credential-state-unknown after an owned refresh commit failure", async () => {
    const stub = await connect("refresh-commit-failure-owned", 0);
    await runInDurableObject(stub, async (instance, state) => {
      const storage = state.storage as unknown as {
        put(key: string, value: unknown): Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (
          typeof value === "object" && value !== null && "state" in value &&
          value.state === "ready" && "generation" in value && value.generation === 2
        ) throw new Error("fake refresh commit failure");
        await originalPut(key, value);
      });
      try {
        await expect(responseStatus(instance.infer(inferenceRequest()))).resolves.toBe(503);
        await expect(instance.status()).resolves.toMatchObject({
          state: "credential-state-unknown",
          reason: "refresh_commit_failed",
        });
      } finally {
        put.mockRestore();
      }
    });
  });

  it("fails closed if refresh commit readback or diagnostic persistence fails", async () => {
    const readbackStub = await connect("refresh-commit-readback-failure", 0);
    await runInDurableObject(readbackStub, async (instance, state) => {
      const storage = state.storage as unknown as {
        get<T>(key: string): Promise<T | undefined>;
        put(key: string, value: unknown): Promise<void>;
      };
      const originalGet = storage.get.bind(storage);
      const originalPut = storage.put.bind(storage);
      let failReadback = false;
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (
          typeof value === "object" && value !== null && "state" in value &&
          value.state === "ready" && "generation" in value && value.generation === 2
        ) {
          failReadback = true;
          throw new Error("fake refresh commit failure before readback");
        }
        await originalPut(key, value);
      });
      const get = vi.spyOn(storage, "get").mockImplementation(async (key) => {
        if (failReadback) {
          failReadback = false;
          throw new Error("fake refresh commit readback failure");
        }
        return originalGet(key);
      });
      try {
        await expect(responseStatus(instance.infer(inferenceRequest()))).resolves.toBe(503);
      } finally {
        get.mockRestore();
        put.mockRestore();
      }
    });

    const diagnosticStub = await connect("refresh-diagnostic-write-failure", 0);
    await runInDurableObject(diagnosticStub, async (instance, state) => {
      const storage = state.storage as unknown as {
        put(key: string, value: unknown): Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (typeof value === "object" && value !== null && "state" in value) {
          if (value.state === "credential-state-unknown")
            throw new Error("fake diagnostic persistence failure");
          if (value.state === "ready" && "generation" in value && value.generation === 2)
            throw new Error("fake refresh commit failure");
        }
        await originalPut(key, value);
      });
      try {
        await expect(responseStatus(instance.infer(inferenceRequest()))).resolves.toBe(503);
      } finally {
        put.mockRestore();
      }
    });
  });

  it("does not report a stale initial ready commit as an owned terminal failure", async () => {
    const stub = testEnv.CODEX_AUTH.getByName("initial-commit-disconnect-race");
    const login = await stub.startLogin();
    await forcePollDue(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const storage = state.storage as unknown as {
        put(key: string, value: unknown): Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      const started = deferred();
      const release = deferred();
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
        if (
          typeof value === "object" && value !== null && "state" in value &&
          value.state === "ready" && "generation" in value && value.generation === 1
        ) {
          started.resolve();
          await release.promise;
          throw new Error("fake delayed initial commit failure");
        }
        await originalPut(key, value);
      });
      try {
        const poll = instance.pollLogin(login.attemptId);
        await started.promise;
        await instance.disconnect();
        release.resolve();
        await expect(poll).resolves.toEqual({ state: "superseded" });
      } finally {
        release.resolve();
        put.mockRestore();
      }
    });
  });
});
