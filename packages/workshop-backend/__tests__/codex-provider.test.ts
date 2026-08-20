import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, CodexModelConfig } from "@gadgets/workshop-shared/api";
import type { CodexRelayStatus } from "@gadgets/workshop-shared/codex-relay";
import {
  CODEX_MODEL_IDS,
  CODEX_QUICK_MODEL_ID,
  SHARED_CODEX_CONNECTION,
  codexCatalogModel,
  codexProfileId,
  getCodexConnectionStatus,
  projectCodexModels,
  resolveCodexModel,
} from "../src/codex-provider.js";
import { getModel } from "../src/ai-models.js";

const INITIATOR: AiChatAuthorInfo = { type: "user", id: "user-1", name: "User" };
type TestRelay = NonNullable<Cloudflare.Env["CODEX_RELAY"]>;

function relay(status: CodexRelayStatus): TestRelay {
  return {
    status: vi.fn(async () => status),
    startLogin: vi.fn(),
    pollLogin: vi.fn(),
    disconnect: vi.fn(),
    infer: vi.fn(),
  } as unknown as TestRelay;
}

function env(binding?: TestRelay, enabled = "true"): Cloudflare.Env {
  return {
    CODEX_SUBSCRIPTION_ENABLED: enabled,
    CODEX_RELAY: binding,
    // These deliberately hostile values prove descriptor resolution chooses the relay first.
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
  } as Cloudflare.Env;
}

describe("shared Codex provider projection", () => {
  it("requires both the explicit feature flag and private relay binding", async () => {
    const binding = relay({ state: "ready", connectionEpoch: "epoch-1", expiresAt: 1 });
    await expect(getCodexConnectionStatus(env(undefined))).resolves.toEqual({ state: "disabled" });
    await expect(getCodexConnectionStatus(env(binding, "false"))).resolves.toEqual({ state: "disabled" });
    await expect(getCodexConnectionStatus(env(binding))).resolves.toMatchObject({ state: "ready" });
    expect(binding.status).toHaveBeenCalledWith(SHARED_CODEX_CONNECTION);
  });

  it("projects only a ready epoch, with Sol first and Luna second", () => {
    expect(projectCodexModels({ state: "disconnected", connectionEpoch: "old" })).toEqual([]);

    const projected = projectCodexModels({
      state: "ready",
      connectionEpoch: "epoch-2",
      expiresAt: Date.now() + 60_000,
    });
    expect(projected.map((entry) => entry.config.model)).toEqual(CODEX_MODEL_IDS);
    expect(CODEX_QUICK_MODEL_ID).toBe("gpt-5.6-luna");
    expect(projected.map((entry) => entry.profile.id)).toEqual(
      CODEX_MODEL_IDS.map(codexProfileId),
    );
    expect(projected.every((entry) =>
      entry.config.connection === SHARED_CODEX_CONNECTION &&
      entry.config.connectionEpoch === "epoch-2")).toBe(true);
    expect(resolveCodexModel(codexProfileId("gpt-5.6-sol"), {
      state: "ready", connectionEpoch: "epoch-3", expiresAt: 1,
    })?.config.connectionEpoch).toBe("epoch-3");
  });

  it("pins names, input capabilities, and limits to Pi's exact catalog", () => {
    for (const modelId of CODEX_MODEL_IDS) {
      const model = codexCatalogModel(modelId);
      expect(model.id).toBe(modelId);
      expect(model.api).toBe("openai-codex-responses");
      expect(model.input).toEqual(["text", "image"]);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
    }
    expect(() => codexCatalogModel("gpt-unpinned")).toThrow("Unsupported shared Codex model");
  });

  it("bypasses both user and platform AI Gateways", () => {
    const binding = relay({ state: "ready", connectionEpoch: "epoch-4", expiresAt: 1 });
    const config: CodexModelConfig = {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      connection: SHARED_CODEX_CONNECTION,
      connectionEpoch: "epoch-4",
    };
    const handle = getModel(env(binding), config, INITIATOR, {
      userGateway: { accountId: "user-account", apiKey: "user-token" },
    });

    expect(handle.model.api).toBe("openai-codex-responses");
    expect(handle.model.baseUrl).toBe(codexCatalogModel("gpt-5.6-sol").baseUrl);
    expect(handle.aiGatewayLogRoute).toBeUndefined();
  });
});
