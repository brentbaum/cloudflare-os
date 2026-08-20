import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";

export { CodexAuth, CodexRelay, default } from "../src/index.js";

type StreamMode = "complete" | "cancellable";

let initialExpiresIn = 3600;
let refreshCalls = 0;
let inferenceCalls = 0;
let streamMode: StreamMode = "complete";
let streamCancellations = 0;
let unauthorizedOnce = false;
let refreshGate: Promise<void> | undefined;
let releaseRefreshGate: (() => void) | undefined;
let lastInferenceHeaders: Record<string, string> = {};

function fakeJwt(accountId: string, generation: number): string {
  const payload = btoa(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `fake-header-${generation}.${payload}.fake-signature-${generation}`;
}

function fakeCredential(generation: number, expiresIn: number) {
  return {
    access_token: fakeJwt("account_workerd_fake", generation),
    refresh_token: `refresh_workerd_fake_${generation}`,
    expires_in: expiresIn,
  };
}

/** Test-only service-binding upstream for deterministic OAuth and SSE behavior. */
@validateRpc()
export class TestUpstream extends WorkerEntrypoint {
  @skipRpcValidation()
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return Response.json({
        device_auth_id: "device_auth_workerd_fake",
        user_code: "WORKERD-FAKE",
        interval: 0,
      });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      return Response.json({
        authorization_code: "authorization_code_workerd_fake",
        code_verifier: "code_verifier_workerd_fake",
      });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
      if (form.get("grant_type") === "refresh_token") {
        refreshCalls++;
        await refreshGate;
        return Response.json(fakeCredential(refreshCalls + 1, 3600));
      }
      return Response.json(fakeCredential(1, initialExpiresIn));
    }
    if (url.pathname === "/backend-api/codex/responses") {
      inferenceCalls++;
      lastInferenceHeaders = Object.fromEntries(request.headers);
      if (unauthorizedOnce) {
        unauthorizedOnce = false;
        return Response.json({ error: "fake_unauthorized" }, { status: 401 });
      }
      if (streamMode === "cancellable") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: fake-first-chunk\n\n"));
          },
          cancel() {
            streamCancellations++;
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("data: fake-complete\n\n", {
        headers: {
          "Content-Type": "text/event-stream",
          "Set-Cookie": "must-not-cross=fake",
          "X-Request-Id": `request-workerd-fake-${inferenceCalls}`,
        },
      });
    }
    return Response.json({ error: "unconfigured_fake_path", path: url.pathname }, { status: 404 });
  }

  reset(): void {
    releaseRefreshGate?.();
    initialExpiresIn = 3600;
    refreshCalls = 0;
    inferenceCalls = 0;
    streamMode = "complete";
    streamCancellations = 0;
    unauthorizedOnce = false;
    refreshGate = undefined;
    releaseRefreshGate = undefined;
    lastInferenceHeaders = {};
  }

  setInitialExpiresIn(seconds: number): void {
    initialExpiresIn = seconds;
  }

  blockRefresh(): void {
    refreshGate = new Promise((resolve) => {
      releaseRefreshGate = resolve;
    });
  }

  releaseRefresh(): void {
    releaseRefreshGate?.();
    refreshGate = undefined;
    releaseRefreshGate = undefined;
  }

  setStreamMode(mode: StreamMode): void {
    streamMode = mode;
  }

  rejectNextInferenceAsUnauthorized(): void {
    unauthorizedOnce = true;
  }

  async waitForRefreshCalls(count: number): Promise<void> {
    while (refreshCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForStreamCancellation(): Promise<void> {
    while (streamCancellations === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  read(): {
    refreshCalls: number;
    inferenceCalls: number;
    streamCancellations: number;
    lastInferenceHeaders: Record<string, string>;
  } {
    return { refreshCalls, inferenceCalls, streamCancellations, lastInferenceHeaders };
  }
}
