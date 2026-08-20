import { describe, expect, it } from "vitest";
import {
  MAX_REFRESH_RETRY_MS,
  MIN_REFRESH_RETRY_MS,
  classifyRefreshHttpFailure,
  codexDownstreamHeaders,
  codexUpstreamHeaders,
  firstUnsupportedKey,
  refreshFailureTransition,
  refreshRetryRemaining,
  terminalPollResult,
} from "../../src/security-critical.js";

describe("security-critical relay decisions in Workerd", () => {
  it("covers every auth, refresh, schema, and redaction decision", () => {
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
    expect(upstream.has("cookie")).toBe(false);
    expect(
      codexDownstreamHeaders(new Headers({ "X-Request-Id": "fake", "Set-Cookie": "secret" })),
    ).toEqual(new Headers({ "X-Request-Id": "fake" }));
    const allowed = new Set(["model"]);
    expect(firstUnsupportedKey({ model: "fake" }, allowed)).toBeUndefined();
    expect(firstUnsupportedKey({ model: "fake", audio: true }, allowed)).toBe("audio");
  });
});
