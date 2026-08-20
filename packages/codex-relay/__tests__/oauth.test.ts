import { describe, expect, it, vi } from "vitest";
import {
  OAuthProtocolError,
  accountIdFromAccessToken,
  createFetchAdapter,
  pollDeviceAuthorization,
  refreshCodexCredential,
  startDeviceAuthorization,
} from "../src/oauth.js";

function fakeJwt(accountId = "acct_unmistakably_fake"): string {
  const payload = btoa(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `fake-header.${payload}.fake-signature`;
}

describe("portable Codex OAuth", () => {
  it("decodes a base64url account scope without Node Buffer", () => {
    expect(accountIdFromAccessToken(fakeJwt("acct_fake_+/"))).toBe("acct_fake_+/");
    expect(accountIdFromAccessToken("not-a-jwt")).toBeUndefined();
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

  it("classifies provider pending and denial responses", async () => {
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
});
