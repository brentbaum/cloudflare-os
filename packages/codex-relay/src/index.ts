import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  CodexConnectionKey,
  CodexDeviceAuthorization,
  CodexDevicePollResult,
  CodexRelayContract,
  CodexRelayStatus,
} from "@gadgets/workshop-shared/codex-relay";
import { CodexAuth } from "./vault.js";

/** Service-binding RPC entrypoint for subscription-backed Codex inference. */
@validateRpc()
export class CodexRelay extends WorkerEntrypoint<Cloudflare.Env> implements CodexRelayContract {
  #connection(connection: CodexConnectionKey) {
    if (connection.length === 0 || connection.length > 256)
      throw new Error("Invalid Codex connection key");
    return this.ctx.exports.CodexAuth.getByName(connection);
  }

  /** Return the connection's non-secret authentication status. */
  status(connection: CodexConnectionKey): Promise<CodexRelayStatus> {
    return this.#connection(connection).status();
  }

  /** Start a latest-login-wins device-authorization attempt. */
  startLogin(connection: CodexConnectionKey): Promise<CodexDeviceAuthorization> {
    return this.#connection(connection).startLogin();
  }

  /** Perform at most one provider-paced poll for a login attempt. */
  pollLogin(connection: CodexConnectionKey, attemptId: string): Promise<CodexDevicePollResult> {
    return this.#connection(connection).pollLogin(attemptId);
  }

  /** Erase credentials and rotate the connection epoch. */
  disconnect(connection: CodexConnectionKey): Promise<void> {
    return this.#connection(connection).disconnect();
  }

  /** Relay one fixed-policy Codex Responses request. */
  @skipRpcValidation()
  infer(connection: CodexConnectionKey, request: Request): Promise<Response> {
    return this.#connection(connection).infer(request);
  }
}

export { CodexAuth };

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
