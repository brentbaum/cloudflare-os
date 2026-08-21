import { describe, expect, it } from "vitest";
import {
  MAX_REFRESH_RETRY_MS,
  MIN_REFRESH_RETRY_MS,
  classifyRefreshHttpFailure,
  codexDownstreamHeaders,
  codexUpstreamHeaders,
  firstUnsupportedKey,
  ownsExchangeIdentity,
  ownsRefreshIdentity,
  refreshFailureTransition,
  refreshRetryRemaining,
  sameEnvelopeIdentity,
  samePendingIdentity,
  sameReadyIdentity,
  terminalPollResult,
} from "../../.wrangler/validate/src/security-critical.js";

describe("security-critical relay decisions in Workerd", () => {
  it("covers every auth, refresh, schema, and redaction decision", () => {
    const envelope = { version: 1, keyId: "current", iv: "iv_fake", ciphertext: "cipher_fake" };
    expect(sameEnvelopeIdentity(envelope, { ...envelope })).toBe(true);
    expect(sameEnvelopeIdentity(envelope, { ...envelope, iv: "other_fake" })).toBe(false);
    const pending = { state: "pending", attemptId: "a", pending: envelope };
    expect(samePendingIdentity(pending, { ...pending })).toBe(true);
    expect(samePendingIdentity(pending, { ...pending, attemptId: "b" })).toBe(false);
    const ready = { state: "ready", generation: 1, credential: envelope };
    expect(sameReadyIdentity(ready, { ...ready })).toBe(true);
    expect(sameReadyIdentity(ready, { ...ready, generation: 2 })).toBe(false);
    const marker = { generation: 1, attemptId: "a", startedAt: 1 };
    expect(ownsRefreshIdentity({ ...ready, refresh: marker }, ready, marker)).toBe(true);
    expect(ownsRefreshIdentity({ ...ready, refresh: { ...marker, attemptId: "b" } }, ready, marker))
      .toBe(false);
    const exchange = { connectionEpoch: "e", attemptId: "a", reason: "exchange" };
    expect(ownsExchangeIdentity({ state: "reauth-required", ...exchange }, exchange)).toBe(true);
    expect(ownsExchangeIdentity({ state: "disconnected", ...exchange }, exchange)).toBe(false);

    expect(classifyRefreshHttpFailure(400, "invalid_grant", undefined).kind).toBe("invalid-grant");
    expect(classifyRefreshHttpFailure(429, undefined, 2_000)).toEqual({
      kind: "transient",
      retryAfterMs: 2_000,
    });
    expect(classifyRefreshHttpFailure(503, undefined, undefined).kind).toBe("ambiguous");

    expect(refreshFailureTransition("invalid-grant", undefined, 0).state).toBe("reauth-required");
    expect(refreshFailureTransition("ambiguous", undefined, 0).state).toBe("reauth-required");
    expect(refreshFailureTransition("invalid-response", undefined, 0).state).toBe(
      "reauth-required",
    );
    expect(refreshFailureTransition("transient", undefined, 0)).toMatchObject({
      state: "retry",
      retryAfterMs: MIN_REFRESH_RETRY_MS,
    });
    expect(refreshFailureTransition("transient", 0, 0)).toMatchObject({
      state: "retry",
      retryAfterMs: MIN_REFRESH_RETRY_MS,
    });
    expect(refreshFailureTransition("transient", 2_000, 0)).toMatchObject({
      state: "retry",
      retryAfterMs: 2_000,
    });
    expect(refreshFailureTransition("transient", Number.MAX_SAFE_INTEGER, 0)).toMatchObject({
      state: "retry",
      retryAfterMs: MAX_REFRESH_RETRY_MS,
    });

    expect(refreshRetryRemaining(undefined, 2, 100)).toBeUndefined();
    expect(refreshRetryRemaining({ generation: 1, notBefore: 200 }, 2, 100)).toBeUndefined();
    expect(refreshRetryRemaining({ generation: 2, notBefore: 100 }, 2, 100)).toBeUndefined();
    expect(refreshRetryRemaining({ generation: 2, notBefore: 200 }, 2, 100)).toBe(100);
    expect(terminalPollResult(true).state).toBe("failed");
    expect(terminalPollResult(false).state).toBe("superseded");

    const upstream = codexUpstreamHeaders({ accessToken: "token_fake", accountId: "account_fake" });
    expect(upstream.get("authorization")).toBe("Bearer token_fake");
    expect(upstream.get("user-agent")).toBe("pi (cloudflare-worker)");
    expect(upstream.has("cookie")).toBe(false);
    expect(
      codexDownstreamHeaders(new Headers({ "X-Request-Id": "fake", "Set-Cookie": "secret" })),
    ).toEqual(new Headers({ "X-Request-Id": "fake" }));
    const allowed = new Set(["model"]);
    expect(firstUnsupportedKey({ model: "fake" }, allowed)).toBeUndefined();
    expect(firstUnsupportedKey({ model: "fake", audio: true }, allowed)).toBe("audio");
  });
});
