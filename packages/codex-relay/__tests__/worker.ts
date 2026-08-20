import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";

export { CodexAuth, CodexRelay, default } from "../src/index.js";

type StreamMode = "complete" | "cancellable" | "premature" | "sized";
type ExchangeMode = "success" | "malformed" | "server-error";
type RefreshMode = "success" | "server-error" | "rate-limited";

let initialExpiresIn = 3600;
let exchangeCalls = 0;
let refreshCalls = 0;
let inferenceCalls = 0;
let streamMode: StreamMode = "complete";
let streamCancellations = 0;
let unauthorizedOnce = false;
let refreshGate: Promise<void> | undefined;
let releaseRefreshGate: (() => void) | undefined;
let lastInferenceHeaders: Record<string, string> = {};
let lastInferenceBody = "";
let exchangeMode: ExchangeMode = "success";
let refreshMode: RefreshMode = "success";
let refreshRetryAfterSeconds = 1;
let streamTotalBytes = 0;
let streamChunkBytes = 0;
let streamBytesProduced = 0;
let streamActivePulls = 0;
let streamMaxActivePulls = 0;

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
        if (refreshMode === "server-error")
          return Response.json({ error: "server_error_fake" }, { status: 503 });
        if (refreshMode === "rate-limited")
          return Response.json({ error: "rate_limit_fake" }, {
            status: 429,
            headers: { "Retry-After": String(refreshRetryAfterSeconds) },
          });
        return Response.json(fakeCredential(refreshCalls + 1, 3600));
      }
      exchangeCalls++;
      if (exchangeMode === "malformed") return Response.json({ access_token: "malformed_fake" });
      if (exchangeMode === "server-error")
        return Response.json({ error: "server_error_fake" }, { status: 503 });
      return Response.json(fakeCredential(1, initialExpiresIn));
    }
    if (url.pathname === "/backend-api/codex/responses") {
      inferenceCalls++;
      lastInferenceHeaders = Object.fromEntries(request.headers);
      lastInferenceBody = await request.clone().text();
      if (unauthorizedOnce) {
        unauthorizedOnce = false;
        return Response.json({ error: "fake_unauthorized" }, { status: 401 });
      }
      if (streamMode === "sized") {
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            streamActivePulls++;
            streamMaxActivePulls = Math.max(streamMaxActivePulls, streamActivePulls);
            try {
              await new Promise((resolve) => setTimeout(resolve, 1));
              if (streamBytesProduced >= streamTotalBytes) {
                controller.close();
                return;
              }
              const size = Math.min(streamChunkBytes, streamTotalBytes - streamBytesProduced);
              streamBytesProduced += size;
              controller.enqueue(new Uint8Array(size).fill(0x66));
              if (streamBytesProduced >= streamTotalBytes) controller.close();
            } finally {
              streamActivePulls--;
            }
          },
        });
        return new Response(stream, { headers: { "Content-Type": "application/octet-stream" } });
      }
      if (streamMode === "premature") {
        let first = true;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (first) {
              first = false;
              controller.enqueue(new TextEncoder().encode("data: fake-partial"));
              return;
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (streamMode === "cancellable") {
        let first = true;
        let heartbeat: ReturnType<typeof setTimeout> | undefined;
        let cancellationObserved = false;
        const observeCancellation = () => {
          if (cancellationObserved) return;
          cancellationObserved = true;
          streamCancellations++;
        };
        request.signal.addEventListener("abort", observeCancellation, { once: true });
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (first) {
              first = false;
              controller.enqueue(new TextEncoder().encode("data: fake-first-chunk\n\n"));
              return;
            }
            await new Promise<void>((resolve) => {
              heartbeat = setTimeout(() => {
                heartbeat = undefined;
                controller.enqueue(new TextEncoder().encode(": fake-heartbeat\n\n"));
                resolve();
              }, 10);
            });
          },
          cancel() {
            if (heartbeat) clearTimeout(heartbeat);
            observeCancellation();
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
    exchangeCalls = 0;
    refreshCalls = 0;
    inferenceCalls = 0;
    streamMode = "complete";
    streamCancellations = 0;
    unauthorizedOnce = false;
    refreshGate = undefined;
    releaseRefreshGate = undefined;
    lastInferenceHeaders = {};
    lastInferenceBody = "";
    exchangeMode = "success";
    refreshMode = "success";
    refreshRetryAfterSeconds = 1;
    streamTotalBytes = 0;
    streamChunkBytes = 0;
    streamBytesProduced = 0;
    streamActivePulls = 0;
    streamMaxActivePulls = 0;
  }

  setInitialExpiresIn(seconds: number): void {
    initialExpiresIn = seconds;
  }

  setExchangeMode(mode: ExchangeMode): void {
    exchangeMode = mode;
  }

  setRefreshMode(mode: RefreshMode): void {
    refreshMode = mode;
  }

  setRefreshRetryAfter(seconds: number): void {
    refreshRetryAfterSeconds = seconds;
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

  configureSizedStream(totalBytes: number, chunkBytes: number): void {
    streamMode = "sized";
    streamTotalBytes = totalBytes;
    streamChunkBytes = chunkBytes;
    streamBytesProduced = 0;
    streamActivePulls = 0;
    streamMaxActivePulls = 0;
  }

  rejectNextInferenceAsUnauthorized(): void {
    unauthorizedOnce = true;
  }

  async waitForRefreshCalls(count: number): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- fetch() updates module state.
    while (refreshCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForStreamCancellation(): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- stream cancellation updates module state.
    while (streamCancellations === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  read(): {
    exchangeCalls: number;
    refreshCalls: number;
    inferenceCalls: number;
    streamCancellations: number;
    lastInferenceHeaders: Record<string, string>;
    lastInferenceBody: string;
    streamBytesProduced: number;
    streamChunkBytes: number;
    streamMaxActivePulls: number;
  } {
    return {
      exchangeCalls,
      refreshCalls,
      inferenceCalls,
      streamCancellations,
      lastInferenceHeaders,
      lastInferenceBody,
      streamBytesProduced,
      streamChunkBytes,
      streamMaxActivePulls,
    };
  }
}
