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
} from "../src/security-critical.js";

describe("security-critical relay decisions", () => {
  it("exhaustively classifies rotating-token HTTP failures", () => {
    expect(classifyRefreshHttpFailure(400, "invalid_grant", undefined)).toEqual({
      kind: "invalid-grant",
    });
    expect(classifyRefreshHttpFailure(429, "rate_limit", 2_000)).toEqual({
      kind: "transient",
      retryAfterMs: 2_000,
    });
    expect(classifyRefreshHttpFailure(503, "server_error", undefined)).toEqual({
      kind: "ambiguous",
    });
  });

  it("compares exact asynchronous state ownership identities", () => {
    const envelope = { version: 1, keyId: "current", iv: "iv_fake", ciphertext: "cipher_fake" };
    expect(sameEnvelopeIdentity(envelope, { ...envelope })).toBe(true);
    expect(sameEnvelopeIdentity(envelope, { ...envelope, ciphertext: "other_fake" })).toBe(false);
    const pending = {
      state: "pending",
      connectionEpoch: "epoch_fake",
      attemptId: "attempt_fake",
      expiresAt: 10,
      nextPollAt: 5,
      pollIntervalMs: 2,
      pending: envelope,
    };
    expect(samePendingIdentity(pending, { ...pending })).toBe(true);
    expect(samePendingIdentity(pending, { ...pending, attemptId: "other_fake" })).toBe(false);
    const ready = {
      state: "ready",
      connectionEpoch: "epoch_fake",
      expiresAt: 10,
      generation: 1,
      credential: envelope,
      refreshRetry: { generation: 1, notBefore: 20 },
    };
    expect(sameReadyIdentity(ready, { ...ready })).toBe(true);
    expect(sameReadyIdentity(ready, { ...ready, generation: 2 })).toBe(false);
    const marker = { generation: 1, attemptId: "refresh_fake", startedAt: 5 };
    expect(ownsRefreshIdentity({ ...ready, refresh: marker }, ready, marker)).toBe(true);
    expect(ownsRefreshIdentity({ ...ready, refresh: { ...marker, startedAt: 6 } }, ready, marker))
      .toBe(false);
    const exchange = {
      connectionEpoch: "epoch_fake",
      attemptId: "attempt_fake",
      reason: "authorization_code_exchange_in_progress",
    };
    expect(ownsExchangeIdentity({ state: "reauth-required", ...exchange }, exchange)).toBe(true);
    expect(ownsExchangeIdentity({ state: "disconnected", ...exchange }, exchange)).toBe(false);
  });

  it("exhaustively maps refresh failures to durable transitions and bounded retry times", () => {
    expect(refreshFailureTransition("invalid-grant", undefined, 10)).toEqual({
      state: "reauth-required",
      reason: "invalid_grant",
    });
    for (const kind of ["ambiguous", "invalid-response"] as const) {
      expect(refreshFailureTransition(kind, undefined, 10)).toEqual({
        state: "reauth-required",
        reason: "ambiguous_refresh",
      });
    }
    expect(refreshFailureTransition("transient", undefined, 10)).toEqual({
      state: "retry",
      notBefore: 10 + MIN_REFRESH_RETRY_MS,
      retryAfterMs: MIN_REFRESH_RETRY_MS,
    });
    expect(refreshFailureTransition("transient", 0, 10)).toMatchObject({
      state: "retry",
      retryAfterMs: MIN_REFRESH_RETRY_MS,
    });
    expect(refreshFailureTransition("transient", 2_000, 10)).toMatchObject({
      state: "retry",
      retryAfterMs: 2_000,
    });
    expect(refreshFailureTransition("transient", Number.MAX_SAFE_INTEGER, 10)).toMatchObject({
      state: "retry",
      retryAfterMs: MAX_REFRESH_RETRY_MS,
    });
  });

  it("applies cooldowns only to the current generation before their deadline", () => {
    expect(refreshRetryRemaining(undefined, 2, 100)).toBeUndefined();
    expect(refreshRetryRemaining({ generation: 1, notBefore: 200 }, 2, 100)).toBeUndefined();
    expect(refreshRetryRemaining({ generation: 2, notBefore: 100 }, 2, 100)).toBeUndefined();
    expect(refreshRetryRemaining({ generation: 2, notBefore: 200 }, 2, 100)).toBe(100);
  });

  it("keeps owned terminal failures distinct from superseded attempts", () => {
    expect(terminalPollResult(true)).toEqual({ state: "failed", reconnectRequired: true });
    expect(terminalPollResult(false)).toEqual({ state: "superseded" });
  });

  it("replaces caller authority and exposes only allowlisted upstream metadata", () => {
    const requestHeaders = codexUpstreamHeaders({
      accessToken: "relay_access_token_fake",
      accountId: "relay_account_fake",
    });
    expect(Object.fromEntries(requestHeaders)).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer relay_access_token_fake",
      "chatgpt-account-id": "relay_account_fake",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "pi",
      version: "0.144.1",
    });
    expect(requestHeaders.has("cookie")).toBe(false);
    expect(requestHeaders.has("host")).toBe(false);

    const responseHeaders = codexDownstreamHeaders(
      new Headers({
        "Content-Type": "text/event-stream",
        "Set-Cookie": "secret-must-not-cross=fake",
        "X-Request-Id": "request_fake",
      }),
    );
    expect(Object.fromEntries(responseHeaders)).toEqual({
      "content-type": "text/event-stream",
      "x-request-id": "request_fake",
    });
  });

  it("fails closed on fields outside an explicit capability schema", () => {
    const allowed = new Set(["model", "stream"]);
    expect(firstUnsupportedKey({ model: "fake", stream: true }, allowed)).toBeUndefined();
    expect(firstUnsupportedKey({ model: "fake", audio: {} }, allowed)).toBe("audio");
  });
});
