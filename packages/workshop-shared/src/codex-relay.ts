/**
 * Opaque identifier for one credential owner inside the private Codex relay.
 *
 * Callers must derive this value server-side. It is routing metadata, not an authorization token.
 */
export type CodexConnectionKey = string;

/** Private service-binding request header carrying the server-owned credential routing key. */
export const CODEX_RELAY_CONNECTION_HEADER = "x-codex-relay-connection";

/** Sanitized lifecycle state for one relay-owned Codex credential. */
export type CodexRelayStatus =
  | { state: "disconnected"; connectionEpoch: string }
  | {
      state: "pending";
      connectionEpoch: string;
      attemptId: string;
      expiresAt: number;
      nextPollAt: number;
    }
  | { state: "ready"; connectionEpoch: string; expiresAt: number }
  | { state: "reauth-required"; connectionEpoch: string; reason: string }
  | { state: "credential-state-unknown"; connectionEpoch: string; reason: string };

/** Device authorization instructions safe to return to a deployment administrator. */
export type CodexDeviceAuthorization = {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  pollIntervalMs: number;
};

/** Sanitized result of polling one device authorization attempt exactly once. */
export type CodexDevicePollResult =
  | { state: "pending"; nextPollAt: number; expiresAt: number }
  | { state: "ready"; connectionEpoch: string; expiresAt: number }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "failed"; reconnectRequired: true }
  | { state: "superseded" };

/**
 * Private RPC management contract implemented by the Codex relay WorkerEntrypoint.
 *
 * OAuth authority never crosses this interface. Management results are sanitized. Inference uses
 * the same binding's standard Fetcher interface so Request cancellation stays on supported HTTP
 * service-binding transport.
 */
export interface CodexRelayContract {
  /** Return sanitized connection state. */
  status(connection: CodexConnectionKey): Promise<CodexRelayStatus>;

  /** Replace any pending login and begin a new device authorization attempt. */
  startLogin(connection: CodexConnectionKey): Promise<CodexDeviceAuthorization>;

  /** Poll the named attempt once, respecting the provider-supplied polling interval. */
  pollLogin(connection: CodexConnectionKey, attemptId: string): Promise<CodexDevicePollResult>;

  /** Delete locally-held authority and invalidate projections tied to the old connection epoch. */
  disconnect(connection: CodexConnectionKey): Promise<void>;
}
