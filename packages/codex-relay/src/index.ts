import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  CodexConnectionKey,
  CodexDeviceAuthorization,
  CodexDevicePollResult,
  CodexRelayContract,
  CodexRelayStatus,
} from "@gadgets/workshop-shared/codex-relay";
import { sanitizeUpstreamResponse } from "./policy.js";
import { CodexAuth } from "./vault.js";

const RPC_DISPOSE = (Symbol as typeof Symbol & { readonly dispose: symbol }).dispose;

function disposeRpcResult(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const dispose = (value as Record<symbol, unknown>)[RPC_DISPOSE];
  if (typeof dispose === "function") dispose.call(value);
}

function copyStatus(status: CodexRelayStatus): CodexRelayStatus {
  switch (status.state) {
    case "pending":
      return {
        state: "pending",
        connectionEpoch: status.connectionEpoch,
        attemptId: status.attemptId,
        expiresAt: status.expiresAt,
        nextPollAt: status.nextPollAt,
      };
    case "ready":
      return {
        state: "ready",
        connectionEpoch: status.connectionEpoch,
        expiresAt: status.expiresAt,
      };
    case "reauth-required":
    case "credential-state-unknown":
      return {
        state: status.state,
        connectionEpoch: status.connectionEpoch,
        reason: status.reason,
      };
    case "disconnected":
      return { state: "disconnected", connectionEpoch: status.connectionEpoch };
  }
}

function copyPollResult(result: CodexDevicePollResult): CodexDevicePollResult {
  switch (result.state) {
    case "pending":
      return { state: "pending", nextPollAt: result.nextPollAt, expiresAt: result.expiresAt };
    case "ready":
      return {
        state: "ready",
        connectionEpoch: result.connectionEpoch,
        expiresAt: result.expiresAt,
      };
    case "denied":
    case "expired":
    case "superseded":
      return { state: result.state };
    case "failed":
      return { state: "failed", reconnectRequired: true };
  }
}

/** Service-binding RPC entrypoint for subscription-backed Codex inference. */
@validateRpc()
export class CodexRelay extends WorkerEntrypoint<Cloudflare.Env> implements CodexRelayContract {
  #connection(connection: CodexConnectionKey) {
    if (connection.length === 0 || connection.length > 256)
      throw new Error("Invalid Codex connection key");
    return this.ctx.exports.CodexAuth.getByName(connection);
  }

  /** Return the connection's non-secret authentication status. */
  async status(connection: CodexConnectionKey): Promise<CodexRelayStatus> {
    const result = await this.#connection(connection).status();
    try {
      return copyStatus(result);
    } finally {
      disposeRpcResult(result);
    }
  }

  /** Start a latest-login-wins device-authorization attempt. */
  async startLogin(connection: CodexConnectionKey): Promise<CodexDeviceAuthorization> {
    const result = await this.#connection(connection).startLogin();
    try {
      return {
        attemptId: result.attemptId,
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        expiresAt: result.expiresAt,
        pollIntervalMs: result.pollIntervalMs,
      };
    } finally {
      disposeRpcResult(result);
    }
  }

  /** Perform at most one provider-paced poll for a login attempt. */
  async pollLogin(
    connection: CodexConnectionKey,
    attemptId: string,
  ): Promise<CodexDevicePollResult> {
    const result = await this.#connection(connection).pollLogin(attemptId);
    try {
      return copyPollResult(result);
    } finally {
      disposeRpcResult(result);
    }
  }

  /** Erase credentials and rotate the connection epoch. */
  disconnect(connection: CodexConnectionKey): Promise<void> {
    return this.#connection(connection).disconnect();
  }

  /** Relay one fixed-policy Codex Responses request. */
  @skipRpcValidation()
  async infer(connection: CodexConnectionKey, request: Request): Promise<Response> {
    const response = await this.#connection(connection).infer(request);
    // Materialize a stream edge at each RPC hop so downstream cancellation reaches the DO-owned
    // upstream reader rather than only releasing the outer capability proxy.
    return sanitizeUpstreamResponse(response);
  }
}

export { CodexAuth };

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
