/**
 * Opaque identifier for one credential owner inside the private Codex relay.
 *
 * Callers must derive this value server-side. It is routing metadata, not an authorization token.
 */
export type CodexConnectionKey = string;

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
  | { state: "superseded" };

/**
 * Private Service Binding contract implemented by the Codex relay WorkerEntrypoint.
 *
 * OAuth authority never crosses this interface. Management results are sanitized and inference
 * accepts a Request capability whose destination and credential headers are replaced by the relay.
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

  /** Forward one fixed-policy Codex Responses request and stream the upstream response unchanged. */
  infer(connection: CodexConnectionKey, request: Request): Promise<Response>;
}
