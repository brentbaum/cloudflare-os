import { describe, expect, it } from "vitest";
import {
  requireCodexModel,
  resolveCodexQuickFallback,
  resolveCurrentCodexSelection,
  selectExternalMessageModelId,
} from "../src/user.js";
import {
  CODEX_QUICK_MODEL_ID,
  SHARED_CODEX_CONNECTION,
  codexProfileId,
} from "../src/codex-provider.js";

const ready = (connectionEpoch: string) => ({
  state: "ready" as const,
  connectionEpoch,
  expiresAt: Date.now() + 60_000,
});

describe("shared Codex user selection policy", () => {
  it("uses Luna for quick work whenever the selected interactive model is Codex", () => {
    expect(resolveCodexQuickFallback(codexProfileId("gpt-5.6-sol"), ready("epoch-1")))
      .toMatchObject({
        provider: "openai-codex",
        model: CODEX_QUICK_MODEL_ID,
        connection: SHARED_CODEX_CONNECTION,
        connectionEpoch: "epoch-1",
      });
    expect(resolveCodexQuickFallback("claude-opus-5", ready("epoch-1"))).toBeUndefined();
  });

  it("invalidates stored quick and preferred selections across connection epochs", () => {
    const luna = codexProfileId(CODEX_QUICK_MODEL_ID);
    expect(resolveCurrentCodexSelection(luna, "epoch-1", ready("epoch-1")))
      .toMatchObject({ config: { model: CODEX_QUICK_MODEL_ID } });
    expect(resolveCurrentCodexSelection(luna, "epoch-1", ready("epoch-2"))).toBeUndefined();
    expect(resolveCurrentCodexSelection(luna, "epoch-1", {
      state: "disconnected", connectionEpoch: "epoch-2",
    })).toBeUndefined();
  });

  it("retains a historical external-message Codex model and fails clearly after disconnect", () => {
    const historical = codexProfileId("gpt-5.6-sol");
    const fallback = { type: "agent" as const, id: "claude-opus-5", name: "Claude" };

    const selected = selectExternalMessageModelId([fallback], historical, fallback.id);
    expect(selected).toBe(historical);
    expect(() => requireCodexModel(selected!, {
      state: "disconnected", connectionEpoch: "epoch-2",
    })).toThrow("shared Codex connection is unavailable");
    expect(() => requireCodexModel(selected!, {
      state: "disconnected", connectionEpoch: "epoch-2",
    })).toThrow("reconnect");
  });
});
