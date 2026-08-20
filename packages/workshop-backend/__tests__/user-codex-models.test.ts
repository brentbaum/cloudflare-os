import { describe, expect, it } from "vitest";
import {
  resolveCodexQuickFallback,
  resolveCurrentCodexSelection,
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
});
