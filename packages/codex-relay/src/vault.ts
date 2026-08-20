import { DurableObject } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  CodexDeviceAuthorization,
  CodexDevicePollResult,
  CodexRelayStatus,
} from "@gadgets/workshop-shared/codex-relay";
import { type EncryptedEnvelope, WrappingKeyring } from "./crypto.js";
import {
  CODEX_DEVICE_VERIFICATION_URI,
  type CodexCredential,
  DEVICE_AUTHORIZATION_LIFETIME_MS,
  OAuthProtocolError,
  createFetchAdapter,
  exchangeDeviceCode,
  pollDeviceAuthorization,
  refreshCodexCredential,
  startDeviceAuthorization,
} from "./oauth.js";
import {
  InferencePolicyError,
  createUpstreamRequest,
  policyErrorResponse,
  sanitizeUpstreamResponse,
  validateInferenceRequest,
} from "./policy.js";
import {
  ownsExchangeIdentity,
  ownsRefreshIdentity,
  refreshFailureTransition,
  refreshRetryRemaining,
  samePendingIdentity,
  sameReadyIdentity,
  terminalPollResult,
} from "./security-critical.js";

const STATE_KEY = "codex-auth-state";
const STATE_VERSION = 1 as const;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type RelayEnv = {
  CODEX_WRAPPING_KEY_CURRENT: string;
  CODEX_WRAPPING_KEY_PREVIOUS?: string;
  CODEX_UPSTREAM?: Fetcher;
};

type StartingState = {
  version: typeof STATE_VERSION;
  state: "starting";
  connectionEpoch: string;
  attemptId: string;
  expiresAt: number;
  nextPollAt: number;
};

type PendingState = {
  version: typeof STATE_VERSION;
  state: "pending";
  connectionEpoch: string;
  attemptId: string;
  expiresAt: number;
  nextPollAt: number;
  pollIntervalMs: number;
  pending: EncryptedEnvelope;
};

type RefreshMarker = { generation: number; attemptId: string; startedAt: number };
type RefreshRetry = { generation: number; notBefore: number };

type ReadyState = {
  version: typeof STATE_VERSION;
  state: "ready";
  connectionEpoch: string;
  expiresAt: number;
  generation: number;
  credential: EncryptedEnvelope;
  refresh?: RefreshMarker;
  refreshRetry?: RefreshRetry;
};

type StoredState =
  | { version: typeof STATE_VERSION; state: "disconnected"; connectionEpoch: string }
  | StartingState
  | PendingState
  | ReadyState
  | {
      version: typeof STATE_VERSION;
      state: "reauth-required";
      connectionEpoch: string;
      reason: string;
      attemptId?: string;
    }
  | {
      version: typeof STATE_VERSION;
      state: "credential-state-unknown";
      connectionEpoch: string;
      reason: string;
    };

type ExchangeMarker = Extract<StoredState, { state: "reauth-required" }>;

type PendingSecret = { deviceAuthId: string; userCode: string };
type CredentialResolution = { credential: CodexCredential; refreshed: boolean };

function samePendingState(current: StoredState, expected: PendingState): current is PendingState {
  return samePendingIdentity(
    current as unknown as Record<string, unknown>,
    expected as unknown as Record<string, unknown>,
  );
}

function sameReadyState(current: StoredState, expected: ReadyState): current is ReadyState {
  return sameReadyIdentity(
    current as unknown as Record<string, unknown>,
    expected as unknown as Record<string, unknown>,
  );
}

function ownsRefresh(
  current: StoredState,
  expected: ReadyState,
  marker: RefreshMarker,
): current is ReadyState {
  return ownsRefreshIdentity(
    current as unknown as Record<string, unknown>,
    expected as unknown as Record<string, unknown>,
    marker,
  );
}

function ownsExchange(current: StoredState, marker: ExchangeMarker): boolean {
  return ownsExchangeIdentity(
    current as unknown as Record<string, unknown>,
    marker,
  );
}

class AuthStateError extends Error {
  constructor(
    public readonly code:
      | "disconnected"
      | "reauth_required"
      | "credential_state_unknown"
      | "refresh_failed",
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "AuthStateError";
  }
}

function newId(): string {
  return crypto.randomUUID();
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthStateError) {
    const status =
      error.code === "credential_state_unknown" || error.code === "refresh_failed" ? 503 : 401;
    const headers = new Headers();
    if (error.code === "refresh_failed" && error.retryAfterMs !== undefined) {
      headers.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
    }
    return Response.json(
      { error: { code: error.code, message: "Codex authentication is unavailable" } },
      { status, headers },
    );
  }
  return Response.json(
    { error: { code: "relay_unavailable", message: "Codex relay is temporarily unavailable" } },
    { status: 503 },
  );
}

/** Durable credential vault and fixed-policy inference relay for one logical connection. */
@validateRpc()
export class CodexAuth extends DurableObject<RelayEnv> {
  readonly #objectId = this.ctx.id.toString();
  readonly #keyringPromise: Promise<WrappingKeyring>;
  readonly #providerFetch: typeof fetch;
  #refreshPromise?: Promise<CredentialResolution>;
  #activeRefreshAttempt?: string;

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.#keyringPromise = WrappingKeyring.create(
      env.CODEX_WRAPPING_KEY_CURRENT,
      env.CODEX_WRAPPING_KEY_PREVIOUS,
    );
    this.#providerFetch = createFetchAdapter(env.CODEX_UPSTREAM);
  }

  #initialState(): StoredState {
    return { version: STATE_VERSION, state: "disconnected", connectionEpoch: newId() };
  }

  async #readRawState(): Promise<StoredState> {
    const state = await this.ctx.storage.get<StoredState>(STATE_KEY);
    if (!state) {
      const initial = this.#initialState();
      await this.ctx.storage.put(STATE_KEY, initial);
      return initial;
    }
    if (state.version !== STATE_VERSION) {
      const unknown: StoredState = {
        version: STATE_VERSION,
        state: "credential-state-unknown",
        connectionEpoch: newId(),
        reason: "unsupported_state_version",
      };
      await this.ctx.storage.put(STATE_KEY, unknown);
      return unknown;
    }
    return state;
  }

  async #readState(): Promise<StoredState> {
    const state = await this.#readRawState();
    if (state.state !== "ready" || !state.refresh) return state;
    if (this.#refreshPromise && this.#activeRefreshAttempt === state.refresh.attemptId)
      return state;
    const unknown: StoredState = {
      version: STATE_VERSION,
      state: "reauth-required",
      connectionEpoch: state.connectionEpoch,
      reason: "interrupted_refresh",
    };
    await this.ctx.storage.put(STATE_KEY, unknown);
    return unknown;
  }

  #writeState(state: StoredState): Promise<void> {
    return this.ctx.storage.put(STATE_KEY, state);
  }

  /** Return the non-secret connection status. */
  async status(): Promise<CodexRelayStatus> {
    const state = await this.#readState();
    switch (state.state) {
      case "starting":
      case "pending":
        return {
          state: "pending",
          connectionEpoch: state.connectionEpoch,
          attemptId: state.attemptId,
          expiresAt: state.expiresAt,
          nextPollAt: state.nextPollAt,
        };
      case "ready":
        return {
          state: "ready",
          connectionEpoch: state.connectionEpoch,
          expiresAt: state.expiresAt,
        };
      case "reauth-required":
        return { state: state.state, connectionEpoch: state.connectionEpoch, reason: state.reason };
      case "credential-state-unknown":
        return { state: state.state, connectionEpoch: state.connectionEpoch, reason: state.reason };
      case "disconnected":
        return { state: state.state, connectionEpoch: state.connectionEpoch };
    }
  }

  /** Supersede any older login and start a fresh device-authorization attempt. */
  async startLogin(): Promise<CodexDeviceAuthorization> {
    const previous = await this.#readState();
    const attemptId = newId();
    const startedAt = Date.now();
    const provisional: StartingState = {
      version: STATE_VERSION,
      state: "starting",
      connectionEpoch: previous.connectionEpoch,
      attemptId,
      expiresAt: startedAt + DEVICE_AUTHORIZATION_LIFETIME_MS,
      nextPollAt: startedAt,
    };
    await this.#writeState(provisional);

    let authorization;
    try {
      authorization = await startDeviceAuthorization(this.#providerFetch);
    } catch (error) {
      const current = await this.#readRawState();
      if (current.state === "starting" && current.attemptId === attemptId) {
        await this.#writeState({
          version: STATE_VERSION,
          state: "disconnected",
          connectionEpoch: current.connectionEpoch,
        });
      }
      throw error;
    }

    const current = await this.#readRawState();
    if (current.state !== "starting" || current.attemptId !== attemptId) {
      throw new Error("Login attempt was superseded");
    }
    const keyring = await this.#keyringPromise;
    const pending = await keyring.encrypt(
      {
        deviceAuthId: authorization.deviceAuthId,
        userCode: authorization.userCode,
      } satisfies PendingSecret,
      this.#objectId,
      STATE_VERSION,
      "pending",
    );
    const afterEncryption = await this.#readRawState();
    if (afterEncryption.state !== "starting" || afterEncryption.attemptId !== attemptId) {
      throw new Error("Login attempt was superseded");
    }
    const now = Date.now();
    const expiresAt = now + DEVICE_AUTHORIZATION_LIFETIME_MS;
    const nextPollAt = now + authorization.pollIntervalMs;
    await this.#writeState({
      version: STATE_VERSION,
      state: "pending",
      connectionEpoch: afterEncryption.connectionEpoch,
      attemptId,
      expiresAt,
      nextPollAt,
      pollIntervalMs: authorization.pollIntervalMs,
      pending,
    });
    return {
      attemptId,
      userCode: authorization.userCode,
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      expiresAt,
      pollIntervalMs: authorization.pollIntervalMs,
    };
  }

  /** Perform at most one provider-paced poll for the current login attempt. */
  async pollLogin(attemptId: string): Promise<CodexDevicePollResult> {
    let state = await this.#readState();
    if (
      (state.state !== "pending" && state.state !== "starting") ||
      state.attemptId !== attemptId
    ) {
      return terminalPollResult(false);
    }
    const now = Date.now();
    if (now >= state.expiresAt) {
      await this.#writeState({
        version: STATE_VERSION,
        state: "disconnected",
        connectionEpoch: state.connectionEpoch,
      });
      return { state: "expired" };
    }
    if (state.state === "starting" || now < state.nextPollAt) {
      return { state: "pending", nextPollAt: state.nextPollAt, expiresAt: state.expiresAt };
    }

    const reservedNextPollAt = now + state.pollIntervalMs;
    state = { ...state, nextPollAt: reservedNextPollAt };
    await this.#writeState(state);
    const keyring = await this.#keyringPromise;
    let secret: PendingSecret;
    try {
      secret = await keyring.decrypt<PendingSecret>(
        state.pending,
        this.#objectId,
        STATE_VERSION,
        "pending",
      );
    } catch {
      const current = await this.#readRawState();
      if (!samePendingState(current, state)) return terminalPollResult(false);
      await this.#writeState({
        version: STATE_VERSION,
        state: "credential-state-unknown",
        connectionEpoch: state.connectionEpoch,
        reason: "pending_state_decryption_failed",
      });
      throw new AuthStateError("credential_state_unknown");
    }
    const beforePoll = await this.#readRawState();
    if (beforePoll.state !== "pending" || beforePoll.attemptId !== attemptId) {
      return terminalPollResult(false);
    }
    const poll = await pollDeviceAuthorization(
      secret.deviceAuthId,
      secret.userCode,
      this.#providerFetch,
    );
    const current = await this.#readRawState();
    if (current.state !== "pending" || current.attemptId !== attemptId)
      return terminalPollResult(false);

    if (poll.state === "pending") {
      const nextPollAt = Math.max(
        Date.now() + current.pollIntervalMs,
        poll.retryAfterMs === undefined ? 0 : Date.now() + poll.retryAfterMs,
      );
      await this.#writeState({ ...current, nextPollAt });
      return { state: "pending", nextPollAt, expiresAt: current.expiresAt };
    }
    if (poll.state === "denied" || poll.state === "expired") {
      await this.#writeState({
        version: STATE_VERSION,
        state: "disconnected",
        connectionEpoch: current.connectionEpoch,
      });
      return { state: poll.state };
    }

    // Persist a terminal marker before dispatching the one-time authorization code. A reset,
    // non-definitive provider response, encryption failure, or ready-state commit failure can then
    // never leave a replayable pending code behind.
    const exchangeMarker: ExchangeMarker = {
      version: STATE_VERSION,
      state: "reauth-required",
      connectionEpoch: current.connectionEpoch,
      reason: "authorization_code_exchange_in_progress",
      attemptId,
    };
    await this.#writeState(exchangeMarker);

    let credential: CodexCredential;
    try {
      credential = await exchangeDeviceCode(
        poll.authorizationCode,
        poll.codeVerifier,
        Date.now(),
        this.#providerFetch,
      );
    } catch {
      const afterFailure = await this.#readRawState();
      if (!ownsExchange(afterFailure, exchangeMarker)) {
        return terminalPollResult(false);
      }
      // The production adapter is either a Workerd Fetcher or global fetch. Both return a Promise
      // before any failure, so every reachable rejection is post-dispatch/ambiguous and terminal.
      // exchangeDeviceCode retains its pre-dispatch classification for pure adapter-level tests,
      // but the vault intentionally never makes a one-time authorization code replayable.
      try {
        await this.#writeState({
          ...exchangeMarker,
          reason: "authorization_code_exchange_failed",
        });
      } catch {
        // The pre-dispatch marker is already terminal and prevents code replay.
      }
      return terminalPollResult(true);
    }
    const afterExchange = await this.#readRawState();
    if (!ownsExchange(afterExchange, exchangeMarker)) {
      return terminalPollResult(false);
    }

    let encrypted: EncryptedEnvelope;
    try {
      encrypted = await keyring.encrypt(credential, this.#objectId, STATE_VERSION, "credential");
    } catch {
      const afterFailure = await this.#readRawState();
      if (ownsExchange(afterFailure, exchangeMarker)) {
        try {
          await this.#writeState({ ...exchangeMarker, reason: "credential_encryption_failed" });
        } catch {
          // The exchange marker remains terminal when its diagnostic refinement cannot commit.
        }
        return terminalPollResult(true);
      }
      return terminalPollResult(false);
    }
    const afterEncryption = await this.#readRawState();
    if (!ownsExchange(afterEncryption, exchangeMarker)) {
      return terminalPollResult(false);
    }
    const connectionEpoch = newId();
    try {
      await this.#writeState({
        version: STATE_VERSION,
        state: "ready",
        connectionEpoch,
        expiresAt: credential.expiresAt,
        generation: 1,
        credential: encrypted,
      });
    } catch {
      try {
        const afterFailure = await this.#readRawState();
        if (ownsExchange(afterFailure, exchangeMarker)) {
          await this.#writeState({ ...exchangeMarker, reason: "credential_commit_failed" });
          return terminalPollResult(true);
        }
      } catch {
        // The durable pre-dispatch marker remains terminal even when this diagnostic write fails.
        return terminalPollResult(true);
      }
      return terminalPollResult(false);
    }
    return { state: "ready", connectionEpoch, expiresAt: credential.expiresAt };
  }

  async #resolveCredential(forceRefresh = false): Promise<CredentialResolution> {
    if (this.#refreshPromise) return this.#refreshPromise;
    const state = await this.#readState();
    if (state.state === "reauth-required") throw new AuthStateError("reauth_required");
    if (state.state === "credential-state-unknown")
      throw new AuthStateError("credential_state_unknown");
    if (state.state !== "ready") throw new AuthStateError("disconnected");
    const keyring = await this.#keyringPromise;
    let credential: CodexCredential;
    try {
      credential = await keyring.decrypt<CodexCredential>(
        state.credential,
        this.#objectId,
        STATE_VERSION,
        "credential",
      );
    } catch {
      const current = await this.#readRawState();
      if (!sameReadyState(current, state)) throw new AuthStateError("disconnected");
      await this.#writeState({
        version: STATE_VERSION,
        state: "credential-state-unknown",
        connectionEpoch: state.connectionEpoch,
        reason: "credential_decryption_failed",
      });
      throw new AuthStateError("credential_state_unknown");
    }
    if (!forceRefresh && credential.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return { credential, refreshed: false };
    }
    const retryRemaining = refreshRetryRemaining(state.refreshRetry, state.generation, Date.now());
    if (retryRemaining !== undefined) throw new AuthStateError("refresh_failed", retryRemaining);
    if (this.#refreshPromise) return this.#refreshPromise;

    const promise = this.#performRefresh(state, credential);
    this.#refreshPromise = promise;
    try {
      return await promise;
    } finally {
      // Only this invocation can install or clear this promise; concurrent callers only await it.
      this.#refreshPromise = undefined;
      this.#activeRefreshAttempt = undefined;
    }
  }

  async #performRefresh(
    state: ReadyState,
    credential: CodexCredential,
  ): Promise<CredentialResolution> {
    const attemptId = newId();
    const marker: RefreshMarker = {
      generation: state.generation,
      attemptId,
      startedAt: Date.now(),
    };
    this.#activeRefreshAttempt = attemptId;
    const beforeMarker = await this.#readRawState();
    if (!sameReadyState(beforeMarker, state)) throw new AuthStateError("disconnected");
    await this.#writeState({ ...beforeMarker, refresh: marker });

    let refreshed: CodexCredential;
    try {
      refreshed = await refreshCodexCredential(
        credential.refreshToken,
        Date.now(),
        this.#providerFetch,
      );
    } catch (error) {
      const current = await this.#readRawState();
      if (!ownsRefresh(current, state, marker)) throw new AuthStateError("disconnected");
      // refreshCodexCredential normalizes every provider/network/parse failure to this protocol
      // error before it crosses the helper boundary.
      const protocolError = error as OAuthProtocolError;
      const transition = refreshFailureTransition(
        protocolError.kind,
        protocolError.retryAfterMs,
        Date.now(),
      );
      if (transition.state === "reauth-required") {
        await this.#writeState({
          version: STATE_VERSION,
          state: "reauth-required",
          connectionEpoch: state.connectionEpoch,
          reason: transition.reason,
        });
        throw new AuthStateError("reauth_required");
      }
      const { refresh: _refresh, ...restored } = current;
      await this.#writeState({
        ...restored,
        refreshRetry: { generation: current.generation, notBefore: transition.notBefore },
      });
      throw new AuthStateError("refresh_failed", transition.retryAfterMs);
    }

    const current = await this.#readRawState();
    if (!ownsRefresh(current, state, marker)) {
      throw new AuthStateError("disconnected");
    }
    const keyring = await this.#keyringPromise;
    let encrypted: EncryptedEnvelope;
    try {
      encrypted = await keyring.encrypt(refreshed, this.#objectId, STATE_VERSION, "credential");
    } catch {
      const afterFailure = await this.#readRawState();
      if (!ownsRefresh(afterFailure, state, marker)) throw new AuthStateError("disconnected");
      await this.#writeState({
        version: STATE_VERSION,
        state: "credential-state-unknown",
        connectionEpoch: state.connectionEpoch,
        reason: "refresh_encryption_failed",
      });
      throw new AuthStateError("credential_state_unknown");
    }
    const afterEncryption = await this.#readRawState();
    if (!ownsRefresh(afterEncryption, state, marker)) {
      throw new AuthStateError("disconnected");
    }
    const next: ReadyState = {
      version: STATE_VERSION,
      state: "ready",
      connectionEpoch: state.connectionEpoch,
      expiresAt: refreshed.expiresAt,
      generation: state.generation + 1,
      credential: encrypted,
    };
    try {
      await this.#writeState(next);
    } catch {
      let afterFailure: StoredState;
      try {
        afterFailure = await this.#readRawState();
      } catch {
        // The durable marker is still the only safe assumption when the commit cannot be read back.
        throw new AuthStateError("credential_state_unknown");
      }
      if (sameReadyState(afterFailure, next)) {
        return { credential: refreshed, refreshed: true };
      }
      if (!ownsRefresh(afterFailure, state, marker)) {
        throw new AuthStateError("disconnected");
      }
      try {
        await this.#writeState({
          version: STATE_VERSION,
          state: "credential-state-unknown",
          connectionEpoch: state.connectionEpoch,
          reason: "refresh_commit_failed",
        });
      } catch {
        // The durable marker remains, so the next invocation also fails closed.
      }
      throw new AuthStateError("credential_state_unknown");
    }
    return { credential: refreshed, refreshed: true };
  }

  /** Delete all pending/credential state and rotate the projection-invalidating epoch. */
  async disconnect(): Promise<void> {
    await this.#writeState({
      version: STATE_VERSION,
      state: "disconnected",
      connectionEpoch: newId(),
    });
  }

  /** Relay one bounded, validated Codex Responses request with DO-owned credentials. */
  @skipRpcValidation()
  async infer(request: Request): Promise<Response> {
    let validated;
    try {
      validated = await validateInferenceRequest(request);
    } catch (error) {
      return error instanceof InferencePolicyError
        ? policyErrorResponse(error)
        : authErrorResponse(error);
    }

    try {
      const resolution = await this.#resolveCredential();
      let response = await this.#fetchUpstream(
        createUpstreamRequest(validated.body, resolution.credential, request.signal),
      );
      if (response.status === 401 && !resolution.refreshed) {
        await response.body?.cancel();
        const retried = await this.#resolveCredential(true);
        response = await this.#fetchUpstream(
          createUpstreamRequest(validated.body, retried.credential, request.signal),
        );
      }
      return sanitizeUpstreamResponse(response);
    } catch (error) {
      return authErrorResponse(error);
    }
  }

  #fetchUpstream(request: Request): Promise<Response> {
    return this.#providerFetch(request);
  }
}
