import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAuthProtocolError,
  accountIdFromAccessToken,
  createFetchAdapter,
  exchangeDeviceCode,
  pollDeviceAuthorization,
  refreshCodexCredential,
  startDeviceAuthorization,
} from "../src/oauth.js";

function fakeJwt(accountId = "acct_unmistakably_fake"): string {
  return fakeJwtPayload({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

function fakeJwtPayload(value: unknown): string {
  const payload = btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `fake-header.${payload}.fake-signature`;
}

async function caught(promise: Promise<unknown>): Promise<OAuthProtocolError> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(OAuthProtocolError);
  return error as OAuthProtocolError;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("portable Codex OAuth", () => {
  it("decodes a base64url account scope without Node Buffer", () => {
    expect(accountIdFromAccessToken(fakeJwt("acct_fake_+/"))).toBe("acct_fake_+/");
    expect(accountIdFromAccessToken("not-a-jwt")).toBeUndefined();
  });

  it("rejects every malformed or missing account-scope shape", () => {
    expect(accountIdFromAccessToken("header..signature")).toBeUndefined();
    expect(accountIdFromAccessToken("header.!.signature")).toBeUndefined();
    expect(accountIdFromAccessToken(fakeJwtPayload(null))).toBeUndefined();
    expect(accountIdFromAccessToken(fakeJwtPayload([]))).toBeUndefined();
    expect(accountIdFromAccessToken(fakeJwtPayload({}))).toBeUndefined();
    expect(accountIdFromAccessToken(fakeJwtPayload({
      "https://api.openai.com/auth": [],
    }))).toBeUndefined();
    expect(accountIdFromAccessToken(fakeJwtPayload({
      "https://api.openai.com/auth": { chatgpt_account_id: 123 },
    }))).toBeUndefined();
    expect(accountIdFromAccessToken(fakeJwtPayload({
      "https://api.openai.com/auth": { chatgpt_account_id: "" },
    }))).toBeUndefined();
  });

  it("starts device authorization and applies provider pacing plus the safety margin", async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        device_auth_id: "device_auth_fake",
        user_code: "FAKE-CODE",
        interval: 7,
      }),
    );

    await expect(startDeviceAuthorization(fakeFetch)).resolves.toEqual({
      deviceAuthId: "device_auth_fake",
      userCode: "FAKE-CODE",
      pollIntervalMs: 10_000,
    });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("routes OAuth through a binding without losing the absolute provider URL", async () => {
    const bindingFetch = vi.fn<(request: Request) => Promise<Response>>().mockResolvedValue(
      Response.json({
        device_auth_id: "device_auth_fake",
        user_code: "FAKE-CODE",
        interval: 5,
      }),
    );
    const adapter = createFetchAdapter({ fetch: bindingFetch });

    await startDeviceAuthorization(adapter);

    const routed = bindingFetch.mock.calls[0]?.[0];
    expect(routed?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(routed?.method).toBe("POST");
    await expect(routed?.json()).resolves.toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  it("uses the injected fallback and the ambient default without a binding", async () => {
    const fallback = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ device_auth_id: "fallback-device", user_code: "FALLBACK" }),
    );
    await startDeviceAuthorization(createFetchAdapter(undefined, fallback));
    expect(fallback).toHaveBeenCalledOnce();

    const ambient = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ device_auth_id: "ambient-device", user_code: "AMBIENT" })
    );
    vi.stubGlobal("fetch", ambient);
    await startDeviceAuthorization(createFetchAdapter());
    await startDeviceAuthorization();
    expect(ambient).toHaveBeenCalledTimes(2);
  });

  it("classifies device-start transport, status, body, and interval failures", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("fake start reset"));
    await expect(caught(startDeviceAuthorization(transport))).resolves.toMatchObject({
      kind: "transient",
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const retryDate = new Date(Date.now() + 4_000).toUTCString();
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 503, headers: { "Retry-After": retryDate } }),
    );
    await expect(caught(startDeviceAuthorization(unavailable))).resolves.toMatchObject({
      kind: "transient",
      status: 503,
      retryAfterMs: 4_000,
    });

    for (const body of [
      "",
      "{not-json",
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify({ device_auth_id: 123, user_code: "FAKE" }),
      JSON.stringify({ device_auth_id: "device_fake", user_code: 123 }),
    ]) {
      const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(caught(startDeviceAuthorization(malformed))).resolves.toMatchObject({
        kind: "invalid-response",
      });
    }

    const stringInterval = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      device_auth_id: "string-interval",
      user_code: "STRING",
      interval: "2",
    }));
    await expect(startDeviceAuthorization(stringInterval)).resolves.toMatchObject({
      pollIntervalMs: 8_000,
    });
    const defaultInterval = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      device_auth_id: "default-interval",
      user_code: "DEFAULT",
    }));
    await expect(startDeviceAuthorization(defaultInterval)).resolves.toMatchObject({
      pollIntervalMs: 8_000,
    });
    const invalidInterval = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      device_auth_id: "invalid-interval",
      user_code: "INVALID",
      interval: "never",
    }));
    await expect(startDeviceAuthorization(invalidInterval)).resolves.toMatchObject({
      pollIntervalMs: 8_000,
    });
  });

  it("classifies provider pending, denial, and expiry responses before status fallbacks", async () => {
    const pendingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));
    await expect(pollDeviceAuthorization("device_fake", "FAKE", pendingFetch)).resolves.toEqual({
      state: "pending",
    });

    const deniedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "access_denied" }, { status: 400 }));
    await expect(pollDeviceAuthorization("device_fake", "FAKE", deniedFetch)).resolves.toEqual({
      state: "denied",
    });

    const denied403 = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "access_denied" }, { status: 403 }));
    await expect(pollDeviceAuthorization("device_fake", "FAKE", denied403)).resolves.toEqual({
      state: "denied",
    });

    const expired404 = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "device_code_expired" }, { status: 404 }));
    await expect(pollDeviceAuthorization("device_fake", "FAKE", expired404)).resolves.toEqual({
      state: "expired",
    });
  });

  it("covers every provider poll status, structured code, and authorized shape", async () => {
    const cases: Array<[Response, unknown]> = [
      [new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
        { state: "pending", retryAfterMs: 2_000 }],
      [Response.json({ error: { code: " SLOW_DOWN " } }, { status: 400 }),
        { state: "pending", retryAfterMs: undefined }],
      [new Response(null, { status: 410 }), { state: "expired" }],
      [Response.json({ error: { type: "expired_token" } }, { status: 400 }),
        { state: "expired" }],
      [Response.json({ code: "expired" }, { status: 400 }), { state: "expired" }],
      [Response.json({ error: "device_authorization_expired" }, { status: 400 }),
        { state: "expired" }],
      [Response.json({ error: "authorization_declined" }, { status: 400 }),
        { state: "denied" }],
      [Response.json({ error: "authorization_pending" }, { status: 400 }),
        { state: "pending" }],
      [new Response(null, { status: 404 }), { state: "pending" }],
      [Response.json({ authorization_code: "code_fake", code_verifier: "verifier_fake" }), {
        state: "authorized",
        authorizationCode: "code_fake",
        codeVerifier: "verifier_fake",
      }],
    ];
    for (const [response, expected] of cases) {
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(pollDeviceAuthorization("device_fake", "FAKE", fakeFetch)).resolves.toEqual(
        expected,
      );
    }
  });

  it("classifies poll transport, generic status, and every malformed authorized body", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("fake poll reset"));
    await expect(caught(pollDeviceAuthorization("device", "CODE", transport))).resolves
      .toMatchObject({ kind: "transient" });

    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: { code: 500 } }, { status: 500 }),
    );
    await expect(caught(pollDeviceAuthorization("device", "CODE", unavailable))).resolves
      .toMatchObject({ kind: "transient", status: 500 });

    for (const body of [
      null,
      [],
      { authorization_code: 123, code_verifier: "verifier" },
      { authorization_code: "code", code_verifier: 123 },
    ]) {
      const malformed = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(caught(pollDeviceAuthorization("device", "CODE", malformed))).resolves
        .toMatchObject({ kind: "invalid-response" });
    }
  });

  it("uses the ambient fetch default for a device poll", async () => {
    const ambient = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "authorization_pending" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", ambient);
    await expect(pollDeviceAuthorization("device", "CODE")).resolves.toEqual({
      state: "pending",
    });
  });

  it("retries only a provably pre-dispatch exchange failure", async () => {
    const synchronousFailure = (() => {
      throw new Error("fake request construction failure");
    }) as typeof fetch;
    const error = await exchangeDeviceCode(
      "code_fake",
      "verifier_fake",
      0,
      synchronousFailure,
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ kind: "transient" });
  });

  it.each([
    ["post-dispatch reset", vi.fn<typeof fetch>().mockRejectedValue(new Error("fake reset"))],
    [
      "nondefinitive provider response",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    ],
    [
      "malformed success",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: fakeJwt() })),
    ],
  ])("classifies %s during authorization-code exchange as ambiguous", async (_name, fakeFetch) => {
    const error = await exchangeDeviceCode("code_fake", "verifier_fake", 0, fakeFetch).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ kind: "ambiguous" });
  });

  it("exchanges a complete credential using default clock and ambient fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const ambient = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: fakeJwt(),
      refresh_token: "exchange_refresh_fake",
      expires_in: 60,
    }));
    vi.stubGlobal("fetch", ambient);
    await expect(exchangeDeviceCode("code_fake", "verifier_fake")).resolves.toMatchObject({
      refreshToken: "exchange_refresh_fake",
      expiresAt: 1_060_000,
    });
  });

  it("rejects every malformed credential field and missing account scope", async () => {
    const malformedResponses = [
      Response.json(null),
      Response.json([]),
      Response.json({ access_token: 123, refresh_token: "refresh", expires_in: 60 }),
      Response.json({ access_token: fakeJwt(), refresh_token: 123, expires_in: 60 }),
      Response.json({ access_token: fakeJwt(), refresh_token: "refresh", expires_in: "60" }),
      new Response(
        `{"access_token":${JSON.stringify(fakeJwt())},"refresh_token":"refresh","expires_in":1e400}`,
      ),
      Response.json({
        access_token: fakeJwtPayload({}),
        refresh_token: "refresh",
        expires_in: 60,
      }),
    ];
    for (const response of malformedResponses) {
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(caught(exchangeDeviceCode("code", "verifier", 0, fakeFetch))).resolves
        .toMatchObject({ kind: "ambiguous" });
    }
  });

  it("accepts only a complete rotated refresh credential", async () => {
    const now = 1_000_000;
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: fakeJwt(),
        refresh_token: "refresh_rotated_fake",
        expires_in: 3600,
      }),
    );

    await expect(refreshCodexCredential("refresh_original_fake", now, fakeFetch)).resolves.toEqual({
      accessToken: fakeJwt(),
      refreshToken: "refresh_rotated_fake",
      accountId: "acct_unmistakably_fake",
      expiresAt: now + 3_600_000,
    });
    const request = fakeFetch.mock.calls[0]?.[1];
    expect(String(request?.body)).toContain("refresh_token=refresh_original_fake");
  });

  it("classifies invalid_grant as reauthentication", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: "invalid_grant", error_description: "fake credential expired" },
          { status: 400 },
        ),
      );

    const error = await refreshCodexCredential("refresh_fake", 0, fakeFetch).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(OAuthProtocolError);
    expect(error).toMatchObject({ kind: "invalid-grant", status: 400 });
  });

  it("classifies a network failure after refresh dispatch as ambiguous", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("fake network interruption"));
    const error = await refreshCodexCredential("refresh_fake", 0, fakeFetch).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ kind: "ambiguous" });
  });

  it("classifies a malformed successful refresh as ambiguous", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ access_token: fakeJwt() }));
    const error = await refreshCodexCredential("refresh_fake", 0, fakeFetch).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ kind: "ambiguous" });
  });

  it("fails closed on a 5xx after a rotating refresh may have been consumed", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "server_error" }, { status: 503 }));
    const error = await refreshCodexCredential("refresh_fake", 0, fakeFetch).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ kind: "ambiguous", status: 503 });
  });

  it("retains the old credential after a definitive pre-consumption 429", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: "rate_limit_exceeded" },
          { status: 429, headers: { "Retry-After": "2" } },
        ),
      );
    const error = await refreshCodexCredential("refresh_fake", 0, fakeFetch).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ kind: "transient", status: 429, retryAfterMs: 2_000 });
  });

  it("parses missing, invalid, past, and future Retry-After values safely", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const cases: Array<[string | undefined, number | undefined]> = [
      [undefined, undefined],
      ["not-a-delay", undefined],
      [new Date(Date.now() - 10_000).toUTCString(), 0],
      [new Date(Date.now() + 5_000).toUTCString(), 5_000],
      ["-1", 0],
    ];
    for (const [retryAfter, expected] of cases) {
      const headers = retryAfter === undefined ? undefined : { "Retry-After": retryAfter };
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ error: "rate_limit" }, { status: 429, headers }),
      );
      await expect(caught(refreshCodexCredential("refresh", 0, fakeFetch))).resolves.toMatchObject({
        kind: "transient",
        retryAfterMs: expected,
      });
    }
  });

  it("uses the ambient fetch and default clock for refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const ambient = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: fakeJwt(),
      refresh_token: "ambient_refresh_fake",
      expires_in: 60,
    }));
    vi.stubGlobal("fetch", ambient);
    await expect(refreshCodexCredential("old_refresh_fake")).resolves.toMatchObject({
      refreshToken: "ambient_refresh_fake",
      expiresAt: 2_060_000,
    });
  });
});
