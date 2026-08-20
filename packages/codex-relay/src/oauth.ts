const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 15_000;

export const CODEX_DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
export const DEVICE_AUTHORIZATION_LIFETIME_MS = 15 * 60 * 1000;
export const MINIMUM_POLL_INTERVAL_MS = 5_000;
const POLL_SAFETY_MARGIN_MS = 3_000;

export type OAuthErrorKind = "ambiguous" | "invalid-grant" | "invalid-response" | "transient";

export class OAuthProtocolError extends Error {
  constructor(
    public readonly kind: OAuthErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "OAuthProtocolError";
  }
}

export type CodexCredential = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
};

export type DeviceAuthorization = {
  deviceAuthId: string;
  userCode: string;
  pollIntervalMs: number;
};

export type DevicePoll =
  | { state: "authorized"; authorizationCode: string; codeVerifier: string }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "pending"; retryAfterMs?: number };

type FetchImplementation = typeof fetch;

type FetchBinding = {
  fetch(request: Request): Promise<Response>;
};

/** Adapt a service binding to fetch while preserving each OAuth request's absolute URL and path. */
export function createFetchAdapter(
  binding?: FetchBinding,
  fallback: FetchImplementation = fetch,
): FetchImplementation {
  return (input, init) =>
    binding ? binding.fetch(new Request(input, init)) : fallback(input, init);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const nested = isRecord(body.error) ? body.error : undefined;
  const value = nested?.code ?? nested?.type ?? body.error ?? body.code;
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function requestSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/** Decode the account identifier from an OpenAI Codex access-token JWT. */
export function accountIdFromAccessToken(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!isRecord(payload)) return undefined;
    const auth = payload[JWT_CLAIM_PATH];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/** Start one OpenAI Codex device-authorization attempt. */
export async function startDeviceAuthorization(
  fetchImpl: FetchImplementation = fetch,
): Promise<DeviceAuthorization> {
  let response: Response;
  try {
    response = await fetchImpl(DEVICE_USERCODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: requestSignal(),
    });
  } catch {
    throw new OAuthProtocolError("transient", "Device authorization is temporarily unavailable");
  }

  if (!response.ok) {
    throw new OAuthProtocolError(
      "transient",
      "Device authorization is temporarily unavailable",
      response.status,
      retryAfterMs(response),
    );
  }
  const body = await responseBody(response);
  if (
    !isRecord(body) ||
    typeof body.device_auth_id !== "string" ||
    typeof body.user_code !== "string"
  ) {
    throw new OAuthProtocolError(
      "invalid-response",
      "Device authorization returned an invalid response",
    );
  }
  const rawInterval =
    typeof body.interval === "number" ? body.interval : Number(body.interval ?? 5);
  const intervalMs = Number.isFinite(rawInterval) ? rawInterval * 1000 : MINIMUM_POLL_INTERVAL_MS;
  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code,
    pollIntervalMs: Math.max(MINIMUM_POLL_INTERVAL_MS, intervalMs) + POLL_SAFETY_MARGIN_MS,
  };
}

/** Perform one provider-paced device-authorization poll. */
export async function pollDeviceAuthorization(
  deviceAuthId: string,
  userCode: string,
  fetchImpl: FetchImplementation = fetch,
): Promise<DevicePoll> {
  let response: Response;
  try {
    response = await fetchImpl(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: requestSignal(),
    });
  } catch {
    throw new OAuthProtocolError("transient", "Device authorization poll failed temporarily");
  }

  if (response.status === 403 || response.status === 404) return { state: "pending" };
  const body = await responseBody(response);
  const code = errorCode(body);
  if (response.status === 429 || code === "slow_down") {
    return { state: "pending", retryAfterMs: retryAfterMs(response) };
  }
  if (response.status === 410 || code === "expired_token" || code === "expired")
    return { state: "expired" };
  if (code === "access_denied" || code === "authorization_declined") return { state: "denied" };
  if (code === "authorization_pending") return { state: "pending" };
  if (!response.ok) {
    throw new OAuthProtocolError(
      "transient",
      "Device authorization poll failed temporarily",
      response.status,
    );
  }
  if (
    !isRecord(body) ||
    typeof body.authorization_code !== "string" ||
    typeof body.code_verifier !== "string"
  ) {
    throw new OAuthProtocolError(
      "invalid-response",
      "Device authorization returned an invalid response",
    );
  }
  return {
    state: "authorized",
    authorizationCode: body.authorization_code,
    codeVerifier: body.code_verifier,
  };
}

async function parseCredential(
  response: Response,
  now: number,
  ambiguity: OAuthErrorKind,
): Promise<CodexCredential> {
  const body = await responseBody(response);
  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in)
  ) {
    throw new OAuthProtocolError(ambiguity, "OAuth token endpoint returned an invalid response");
  }
  const accountId = accountIdFromAccessToken(body.access_token);
  if (!accountId)
    throw new OAuthProtocolError(ambiguity, "OAuth access token is missing its account scope");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accountId,
    expiresAt: now + body.expires_in * 1000,
  };
}

/** Exchange a completed device authorization for the initial credential. */
export async function exchangeDeviceCode(
  authorizationCode: string,
  codeVerifier: string,
  now = Date.now(),
  fetchImpl: FetchImplementation = fetch,
): Promise<CodexCredential> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }),
      signal: requestSignal(),
    });
  } catch {
    throw new OAuthProtocolError("transient", "OAuth token exchange failed temporarily");
  }
  if (!response.ok) {
    throw new OAuthProtocolError("transient", "OAuth token exchange was rejected", response.status);
  }
  return parseCredential(response, now, "invalid-response");
}

/** Refresh a rotating Codex credential, classifying post-send uncertainty as ambiguous. */
export async function refreshCodexCredential(
  refreshToken: string,
  now = Date.now(),
  fetchImpl: FetchImplementation = fetch,
): Promise<CodexCredential> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: requestSignal(),
    });
  } catch {
    throw new OAuthProtocolError("ambiguous", "Credential refresh outcome is unknown");
  }

  if (!response.ok) {
    const body = await responseBody(response);
    if (errorCode(body) === "invalid_grant") {
      throw new OAuthProtocolError(
        "invalid-grant",
        "Credential refresh requires login",
        response.status,
      );
    }
    if (response.status === 429) {
      throw new OAuthProtocolError(
        "transient",
        "Credential refresh was rate limited",
        response.status,
        retryAfterMs(response),
      );
    }
    throw new OAuthProtocolError(
      "ambiguous",
      "Credential refresh outcome is unknown",
      response.status,
    );
  }
  return parseCredential(response, now, "ambiguous");
}
