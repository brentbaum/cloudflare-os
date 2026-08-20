import type { CodexDevicePollResult } from "@gadgets/workshop-shared/codex-relay";

export const MIN_REFRESH_RETRY_MS = 1_000;
export const MAX_REFRESH_RETRY_MS = 5 * 60 * 1000;

export type RefreshFailureKind =
  | "ambiguous"
  | "invalid-grant"
  | "invalid-response"
  | "transient";

export type RefreshFailureTransition =
  | { state: "reauth-required"; reason: "ambiguous_refresh" | "invalid_grant" }
  | { state: "retry"; notBefore: number; retryAfterMs: number };

type EnvelopeIdentity = { version: number; keyId: string; iv: string; ciphertext: string };
type RefreshIdentity = { generation: number; attemptId: string; startedAt: number };

function fieldValues(value: unknown, fields: readonly string[]): unknown[] {
  const record = Object(value) as Record<string, unknown>;
  return fields.map((field) => record[field]);
}

function envelopeValues(value: unknown): unknown[] {
  return fieldValues(value, ["version", "keyId", "iv", "ciphertext"]);
}

/** Compare encrypted envelopes without ever decrypting or logging their contents. */
export function sameEnvelopeIdentity(left: EnvelopeIdentity, right: EnvelopeIdentity): boolean {
  return JSON.stringify([left.version, left.keyId, left.iv, left.ciphertext]) ===
    JSON.stringify([right.version, right.keyId, right.iv, right.ciphertext]);
}

/** Compare the exact pending state that an asynchronous poll operation reserved. */
export function samePendingIdentity(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const identity = (value: Record<string, unknown>) => [
    ...fieldValues(value, [
      "state",
      "connectionEpoch",
      "attemptId",
      "expiresAt",
      "nextPollAt",
      "pollIntervalMs",
    ]),
    envelopeValues(value.pending),
  ];
  return JSON.stringify(identity(current)) === JSON.stringify(identity(expected));
}

/** Compare the exact ready generation an asynchronous credential operation observed. */
export function sameReadyIdentity(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const identity = (value: Record<string, unknown>) => [
    ...fieldValues(value, ["state", "connectionEpoch", "expiresAt", "generation"]),
    envelopeValues(value.credential),
    fieldValues(value.refresh, ["generation", "attemptId", "startedAt"]),
    fieldValues(value.refreshRetry, ["generation", "notBefore"]),
  ];
  return JSON.stringify(identity(current)) === JSON.stringify(identity(expected));
}

/** Verify that a stored ready state still owns the exact in-progress refresh marker. */
export function ownsRefreshIdentity(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
  marker: RefreshIdentity,
): boolean {
  return sameReadyIdentity(current, { ...expected, refresh: marker });
}

/** Verify that a stored terminal marker still belongs to the same login exchange. */
export function ownsExchangeIdentity(
  current: Record<string, unknown>,
  marker: { connectionEpoch: string; attemptId?: string; reason: string },
): boolean {
  return JSON.stringify([
    current.state,
    current.connectionEpoch,
    current.attemptId,
    current.reason,
  ]) === JSON.stringify([
    "reauth-required",
    marker.connectionEpoch,
    marker.attemptId,
    marker.reason,
  ]);
}

/** Classify a non-successful rotating-token response without assuming the token is reusable. */
export function classifyRefreshHttpFailure(
  status: number,
  code: string | undefined,
  retryAfterMs: number | undefined,
): { kind: "invalid-grant" | "transient" | "ambiguous"; retryAfterMs?: number } {
  if (code === "invalid_grant") return { kind: "invalid-grant" };
  if (status === 429) return { kind: "transient", retryAfterMs };
  return { kind: "ambiguous" };
}

/** Convert a refresh failure into the only safe durable authentication transition. */
export function refreshFailureTransition(
  kind: RefreshFailureKind,
  retryAfterMs: number | undefined,
  now: number,
): RefreshFailureTransition {
  if (kind === "invalid-grant") return { state: "reauth-required", reason: "invalid_grant" };
  if (kind !== "transient") {
    return { state: "reauth-required", reason: "ambiguous_refresh" };
  }
  let boundedRetryMs = retryAfterMs ?? MIN_REFRESH_RETRY_MS;
  if (boundedRetryMs < MIN_REFRESH_RETRY_MS) boundedRetryMs = MIN_REFRESH_RETRY_MS;
  if (boundedRetryMs > MAX_REFRESH_RETRY_MS) boundedRetryMs = MAX_REFRESH_RETRY_MS;
  return { state: "retry", notBefore: now + boundedRetryMs, retryAfterMs: boundedRetryMs };
}

/** Return a stored generation's remaining cooldown, or no cooldown when it is inapplicable. */
export function refreshRetryRemaining(
  retry: { generation: number; notBefore: number } | undefined,
  generation: number,
  now: number,
): number | undefined {
  if (retry === undefined) return undefined;
  if (retry.generation !== generation) return undefined;
  if (retry.notBefore <= now) return undefined;
  return retry.notBefore - now;
}

/** Distinguish a terminal owned login failure from a genuinely superseded login attempt. */
export function terminalPollResult(owned: boolean): CodexDevicePollResult {
  return owned ? { state: "failed", reconnectRequired: true } : { state: "superseded" };
}

/** Build authority headers exclusively from relay-owned credentials, ignoring caller authority. */
export function codexUpstreamHeaders(
  credential: { accessToken: string; accountId: string },
): Headers {
  return new Headers({
    Accept: "text/event-stream",
    Authorization: `Bearer ${credential.accessToken}`,
    "ChatGPT-Account-Id": credential.accountId,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    Originator: "pi",
    Version: "0.144.1",
  });
}

const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "openai-processing-ms",
  "openai-version",
  "request-id",
  "retry-after",
  "x-request-id",
]);

/** Copy only response metadata safe to expose across the relay trust boundary. */
export function codexDownstreamHeaders(upstream: Headers): Headers {
  const downstream = new Headers();
  for (const [name, value] of upstream) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) downstream.append(name, value);
  }
  return downstream;
}

/** Find the first field outside an explicit capability schema. */
export function firstUnsupportedKey(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}
