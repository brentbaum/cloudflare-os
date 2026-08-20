import { env as workerEnv, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { Context } from "@earendil-works/pi-ai";
import type {
  AdminApi,
  AiChatAuthorInfo,
  AiChatMetadata,
  AuthenticatedApi,
  CodexModelConfig,
  Overseer,
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
import type { UserDurableObject } from "../src/user.js";

type CrossPackageUpstreamControl = {
  reset(): Promise<void>;
  setInitialExpiresIn(seconds: number): Promise<void>;
  blockRefresh(): Promise<void>;
  releaseRefresh(): Promise<void>;
  setStreamMode(
    mode: "complete" | "cancellable" | "tool-continuation" | "premature-close",
  ): Promise<void>;
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

const runtimeExports = workerExports as unknown as {
  default: Fetcher;
  UserDurableObject: DurableObjectNamespace<UserDurableObject>;
};

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
  const response = await runtimeExports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected the backend to return a WebSocket");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function waitForChatIdle(
  workspace: RpcStub<Overseer>,
  chatId: number,
): Promise<AiChatMetadata> {
  return bounded((async () => {
    for (;;) {
      const chat = (await workspace.listChats()).find((candidate) => candidate.id === chatId);
      if (chat && !chat.activeAgent) return chat;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })(), "workspace Codex turn", 8_000);
}

async function rejection(value: PromiseLike<unknown>): Promise<Error> {
  try {
    await value;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected RPC to reject with an Error.", { cause: error });
  }
  throw new Error("Expected RPC to reject.");
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

  it("covers shared login, streams, workspace billing bypass, cancellation, and disconnect", async () => {
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

    // Exhaust the ordinary platform quota before taking the real authenticated workspace path.
    // A non-Codex model would be rejected by checkUsageAndBalance() before inference, so the
    // successful turn below dynamically proves that shared Codex bypasses that billing gate.
    const quotaUser = runtimeExports.UserDurableObject.getByName("codexuser");
    expect(await quotaUser.consumeDailyLlmCall(1)).toMatchObject({
      withinLimits: true,
      remaining: 0,
      limit: 1,
      used: 1,
    });
    expect(await user.getCloudflareUsage()).toMatchObject({
      cloudflareLimitsEnabled: true,
      unlimited: false,
      dailyUsed: 1,
      dailyLimit: 1,
      remaining: 0,
    });

    await testEnv.CODEX_UPSTREAM.setStreamMode("complete");
    const workspaceInferenceStart = (await testEnv.CODEX_UPSTREAM.read()).inferenceCalls;
    const historicalModelId = codexProfileId("gpt-5.6-sol");
    using workspace = await user.newGadget();
    const image = await workspace.uploadChatAttachment({
      mimeType: "image/png",
      name: "authenticated-cross-package.png",
      content: new Uint8Array([0x89, 0x50, 0x4E, 0x47]),
    }, historicalModelId);
    const chatId = await workspace.newChat(
      "Exercise the authenticated workspace Codex path",
      historicalModelId,
      undefined,
      [image],
    );
    // The primary Sol turn and catalog-pinned Luna title turn both traverse the relay.
    await bounded(
      testEnv.CODEX_UPSTREAM.waitForInferenceCalls(workspaceInferenceStart + 2),
      "workspace and quick-model inference",
    );
    const completedChat = await waitForChatIdle(workspace, chatId);
    expect(completedChat.totalCost).toBeNull();
    expect((await workspace.getMetadata()).totalCost).toBeNull();

    const history = await workspace.getChatHistory(chatId);
    expect(history.messages).toContainEqual(expect.objectContaining({
      author: expect.objectContaining({ type: "agent", id: historicalModelId }),
      type: "message",
      message: "Cross-package hello",
    }));
    const workspaceUpstream = await testEnv.CODEX_UPSTREAM.read();
    expect(workspaceUpstream.inferenceCalls).toBeGreaterThan(workspaceInferenceStart);
    const workspaceBodies = workspaceUpstream.inferenceBodies.slice(workspaceInferenceStart);
    expect(workspaceBodies.some((body) =>
      JSON.stringify(body).includes("Exercise the authenticated workspace Codex path")
    )).toBe(true);
    expect(workspaceBodies.some((body) =>
      JSON.stringify(body).includes("data:image/png;base64,iVBOR")
    )).toBe(true);
    expect(JSON.stringify(workspaceBodies)).not.toMatch(
      /platform-(?:gateway|account|token)-must-not-cross|user-gateway-(?:account|token)-must-not-cross/,
    );
    expect(workspaceUpstream.lastInferenceHeaders["cf-aig-metadata"]).toBeUndefined();
    expect(workspaceUpstream.lastInferenceHeaders["cf-aig-authorization"]).toBeUndefined();
    expect(JSON.stringify(workspaceUpstream.lastInferenceHeaders)).not.toMatch(
      /platform-(?:gateway|account|token)-must-not-cross|user-gateway-(?:account|token)-must-not-cross/,
    );
    // Codex did not merely sneak through an exhausted check: the ordinary quota was untouched.
    expect(await user.getCloudflareUsage()).toMatchObject({ dailyUsed: 1, remaining: 0 });

    await testEnv.CODEX_UPSTREAM.setStreamMode("tool-continuation");
    const toolInferenceStart = workspaceUpstream.inferenceCalls;
    const toolChatId = await workspace.newChat(
      "Exercise multi-turn function continuation",
      historicalModelId,
    );
    // Initial tool call, catalog-pinned Luna title, and post-tool continuation.
    await bounded(
      testEnv.CODEX_UPSTREAM.waitForInferenceCalls(toolInferenceStart + 3),
      "multi-turn tool continuation",
    );
    await waitForChatIdle(workspace, toolChatId);
    const toolHistory = await workspace.getChatHistory(toolChatId);
    expect(toolHistory.messages.some((message) =>
      message.type === "message" && message.author.type === "agent" &&
      message.toolCalls?.some((tool) => tool.toolName === "observeUserChanges")
    )).toBe(true);
    expect(toolHistory.messages).toContainEqual(expect.objectContaining({
      author: expect.objectContaining({ type: "agent", id: historicalModelId }),
      type: "message",
      message: "Tool continuation complete",
    }));
    const toolBodies = (await testEnv.CODEX_UPSTREAM.read()).inferenceBodies
      .slice(toolInferenceStart);
    expect(toolBodies.some((body) => JSON.stringify(body).includes("function_call_output")))
      .toBe(true);

    await testEnv.CODEX_UPSTREAM.setStreamMode("premature-close");
    const prematureChatId = await workspace.newChat(
      "Exercise premature SSE closure",
      historicalModelId,
    );
    const prematureChat = await waitForChatIdle(workspace, prematureChatId);
    expect(prematureChat.totalCost).toBeUndefined();
    const prematureHistory = await workspace.getChatHistory(prematureChatId);
    expect(prematureHistory.messages.some((message) =>
      message.type === "error" && message.author.type === "agent" &&
      /ended before a terminal response event/i.test(message.message)
    )).toBe(true);

    await adminApi.disconnectCodex();
    expect((await adminApi.getCodexConnectionStatus()).state).toBe("disconnected");
    expectCodexModels(await admin.listModels(), false);
    expectCodexModels(await user.listModels(), false);

    const beforeUnavailable = (await testEnv.CODEX_UPSTREAM.read()).inferenceCalls;
    const unavailable = await run(handle, "Old handle must not silently fall back");
    expect(unavailable.stopReason).toBe("error");
    expect(unavailable.errorMessage).toMatch(/authentication|disconnected|unavailable/i);
    expect((await testEnv.CODEX_UPSTREAM.read()).inferenceCalls).toBe(beforeUnavailable);

    const historicalChatError = await runInDurableObject(quotaUser, async (instance) =>
      rejection(instance.getChatContext(historicalModelId)));
    expect(historicalChatError.message).toBe(
      "The shared Codex connection is unavailable. Ask a deployment administrator to reconnect it.",
    );
    expect((await testEnv.CODEX_UPSTREAM.read()).inferenceCalls).toBe(beforeUnavailable);
  });
});
