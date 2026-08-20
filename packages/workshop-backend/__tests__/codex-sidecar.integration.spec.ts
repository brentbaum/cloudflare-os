import { env as workerEnv, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { Context } from "@earendil-works/pi-ai";
import type {
  AdminApi,
  AiChatAuthorInfo,
  AuthenticatedApi,
  CodexModelConfig,
  PublicApi,
} from "@gadgets/workshop-shared/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexAuth } from "../../codex-relay/src/vault.js";
import {
  CODEX_MODEL_IDS,
  SHARED_CODEX_CONNECTION,
  codexProfileId,
} from "../src/codex-provider.js";
import { getModel, type ModelHandle } from "../src/ai-models.js";

type CrossPackageUpstreamControl = {
  reset(): Promise<void>;
  setInitialExpiresIn(seconds: number): Promise<void>;
  blockRefresh(): Promise<void>;
  releaseRefresh(): Promise<void>;
  setStreamMode(mode: "complete" | "cancellable"): Promise<void>;
  waitForRefreshCalls(count: number): Promise<void>;
  waitForInferenceCalls(count: number): Promise<void>;
  waitForStreamCancellation(): Promise<void>;
  read(): Promise<{
    refreshCalls: number;
    inferenceCalls: number;
    streamCancellations: number;
    lastInferenceHeaders: Record<string, string>;
    inferenceBodies: Array<Record<string, unknown>>;
  }>;
};

type CrossPackageRelayControl = {
  readRequestSignalAborted(): Promise<boolean>;
};

const testEnv = workerEnv as unknown as Cloudflare.Env & {
  CODEX_AUTH: DurableObjectNamespace<CodexAuth>;
  CODEX_RELAY: Fetcher & CrossPackageRelayControl;
  CODEX_UPSTREAM: Fetcher & CrossPackageUpstreamControl;
};

const STATE_KEY = "codex-auth-state";
const PASSWORD_HASH = new Uint8Array([11, 22, 33]);
const CODEX_PROFILE_IDS = CODEX_MODEL_IDS.map(codexProfileId);

async function bounded<T>(promise: PromiseLike<T>, label: string, timeoutMs = 3_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await workerExports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected the backend to return a WebSocket");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAuthenticated(
  publicApi: RpcStub<PublicApi>,
  username: string,
): Promise<RpcStub<AuthenticatedApi>> {
  const token = await publicApi.createAccount(username, username, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${username}`);
  return (await publicApi.authenticate(token)) as unknown as RpcStub<AuthenticatedApi>;
}

async function forceDevicePollDue(): Promise<void> {
  const stub = testEnv.CODEX_AUTH.getByName(SHARED_CODEX_CONNECTION);
  await runInDurableObject(stub, async (_instance, state) => {
    const stored = await state.storage.get<Record<string, unknown>>(STATE_KEY);
    if (!stored) throw new Error("Missing fake pending Codex state");
    await state.storage.put(STATE_KEY, { ...stored, nextPollAt: 0 });
  });
}

function expectCodexModels(models: readonly AiChatAuthorInfo[], present: boolean): void {
  for (const id of CODEX_PROFILE_IDS) {
    expect(models.some((model) => model.id === id)).toBe(present);
  }
}

function codexHandle(connectionEpoch: string): ModelHandle {
  const config: CodexModelConfig = {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    connection: SHARED_CODEX_CONNECTION,
    connectionEpoch,
  };
  return getModel(
    testEnv,
    config,
    { type: "user", id: "codexuser", name: "codexuser" },
    {
      userGateway: {
        accountId: "user-gateway-account-must-not-cross",
        apiKey: "user-gateway-token-must-not-cross",
      },
    },
  );
}

function run(handle: ModelHandle, prompt: string, signal?: AbortSignal) {
  const context: Context = {
    messages: [{ role: "user", content: prompt, timestamp: 0 }],
  };
  return handle.stream(handle.model, context, signal ? { signal } : {}).result();
}

describe("backend to private Codex sidecar lifecycle", () => {
  beforeEach(() => testEnv.CODEX_UPSTREAM.reset());
  afterEach(async () => {
    await testEnv.CODEX_UPSTREAM.reset();
    await reset();
  });

  it("gates management, shares models, streams through one refresh, cancels, and disconnects", async () => {
    using publicApi = await connect();
    using admin = await createAuthenticated(publicApi, "codexadmin");
    using user = await createAuthenticated(publicApi, "codexuser");

    expect(await user.getAdminApi()).toBeNull();
    const maybeAdminApi = await admin.getAdminApi();
    expect(maybeAdminApi).not.toBeNull();
    if (!maybeAdminApi) throw new Error("Configured admin did not receive AdminApi");
    using adminApi: RpcStub<AdminApi> = maybeAdminApi;

    expectCodexModels(await admin.listModels(), false);
    expectCodexModels(await user.listModels(), false);

    await testEnv.CODEX_UPSTREAM.setInitialExpiresIn(0);
    const login = await adminApi.startCodexLogin();
    expect(login.userCode).toBe("CROSS-PACKAGE-FAKE");
    expect(login.verificationUri).toBe("https://auth.openai.com/codex/device");
    await forceDevicePollDue();
    const connected = await adminApi.pollCodexLogin(login.attemptId);
    expect(connected.state).toBe("ready");
    if (connected.state !== "ready") throw new Error("Fake Codex login did not become ready");

    expectCodexModels(await admin.listModels(), true);
    expectCodexModels(await user.listModels(), true);

    const handle = codexHandle(connected.connectionEpoch);
    expect(handle.aiGatewayLogRoute).toBeUndefined();
    await testEnv.CODEX_UPSTREAM.blockRefresh();
    const first = run(handle, "First fake prompt");
    const second = run(handle, "Second fake prompt");
    await bounded(Promise.race([
      testEnv.CODEX_UPSTREAM.waitForRefreshCalls(1),
      first.then((result) => {
        throw new Error(`First Pi stream ended before refresh: ${result.errorMessage ?? result.stopReason}`);
      }),
      second.then((result) => {
        throw new Error(`Second Pi stream ended before refresh: ${result.errorMessage ?? result.stopReason}`);
      }),
    ]), "one cross-package refresh");
    expect((await testEnv.CODEX_UPSTREAM.read()).refreshCalls).toBe(1);
    await testEnv.CODEX_UPSTREAM.releaseRefresh();

    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual(expect.objectContaining({
        type: "text",
        text: "Cross-package hello",
      }));
    }
    const completed = await testEnv.CODEX_UPSTREAM.read();
    expect(completed).toMatchObject({ refreshCalls: 1, inferenceCalls: 2 });
    expect(completed.inferenceBodies).toHaveLength(2);
    expect(completed.inferenceBodies.every((body) =>
      body.model === "gpt-5.6-sol" && body.stream === true && body.store === false
    )).toBe(true);
    expect(JSON.stringify(completed.inferenceBodies)).toContain("First fake prompt");
    expect(JSON.stringify(completed.inferenceBodies)).toContain("Second fake prompt");
    expect(completed.lastInferenceHeaders.authorization).toMatch(/^Bearer fake-header-/);
    expect(completed.lastInferenceHeaders["chatgpt-account-id"])
      .toBe("account_cross_package_fake");
    expect(completed.lastInferenceHeaders["cf-aig-metadata"]).toBeUndefined();
    expect(completed.lastInferenceHeaders["cf-aig-authorization"]).toBeUndefined();
    expect(JSON.stringify(completed.lastInferenceHeaders))
      .not.toContain("gateway-token-must-not-cross");

    await testEnv.CODEX_UPSTREAM.setStreamMode("cancellable");
    const controller = new AbortController();
    const cancellableStream = handle.stream(handle.model, {
      messages: [{ role: "user", content: "Cancel this fake prompt", timestamp: 0 }],
    }, { signal: controller.signal });
    const cancelled = cancellableStream.result();
    const cancellableEvents = cancellableStream[Symbol.asyncIterator]();
    await bounded(testEnv.CODEX_UPSTREAM.waitForInferenceCalls(3), "cancellable upstream request");
    expect((await bounded(cancellableEvents.next(), "Pi stream start")).value)
      .toMatchObject({ type: "start" });
    controller.abort(new DOMException("cross-package fake cancellation", "AbortError"));
    await bounded(testEnv.CODEX_UPSTREAM.waitForStreamCancellation(), "upstream stream cancellation");
    expect((await bounded(cancelled, "cancelled Pi result")).stopReason).toBe("aborted");
    await cancellableEvents.return?.();
    expect(await testEnv.CODEX_RELAY.readRequestSignalAborted()).toBe(false);
    expect((await testEnv.CODEX_UPSTREAM.read()).streamCancellations).toBe(1);

    await adminApi.disconnectCodex();
    expect((await adminApi.getCodexConnectionStatus()).state).toBe("disconnected");
    expectCodexModels(await admin.listModels(), false);
    expectCodexModels(await user.listModels(), false);

    const beforeUnavailable = (await testEnv.CODEX_UPSTREAM.read()).inferenceCalls;
    const unavailable = await run(handle, "Old handle must not silently fall back");
    expect(unavailable.stopReason).toBe("error");
    expect(unavailable.errorMessage).toMatch(/authentication|disconnected|unavailable/i);
    expect((await testEnv.CODEX_UPSTREAM.read()).inferenceCalls).toBe(beforeUnavailable);
  });
});
