import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";

export { CodexAuth, CodexRelay, default } from "../src/index.js";

type StreamMode = "complete" | "cancellable" | "premature" | "sized" | "timed";
type ExchangeMode = "success" | "malformed" | "server-error";
type RefreshMode = "success" | "server-error" | "rate-limited" | "erroring-body";
type DeviceStartMode = "success" | "server-error";
type DevicePollMode = "authorized" | "denied" | "expired" | "pending" | "rate-limited";

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
let lastInferenceUrl = "";
let exchangeMode: ExchangeMode = "success";
let refreshMode: RefreshMode = "success";
let refreshRetryAfterSeconds = 1;
let streamTotalBytes = 0;
let streamChunkBytes = 0;
let streamBytesProduced = 0;
let streamBytesProducedAtHeaders = 0;
let streamProductionCompletedAt = 0;
let streamActivePulls = 0;
let streamMaxActivePulls = 0;
let firstByteTimestamps: number[] = [];
let cancellationTimestamps: number[] = [];
let deviceStartMode: DeviceStartMode = "success";
let devicePollMode: DevicePollMode = "authorized";
let deviceStartCalls = 0;
let devicePollCalls = 0;
let deviceStartGate: Promise<void> | undefined;
let releaseDeviceStartGate: (() => void) | undefined;
let devicePollGate: Promise<void> | undefined;
let releaseDevicePollGate: (() => void) | undefined;
let exchangeGate: Promise<void> | undefined;
let releaseExchangeGate: (() => void) | undefined;

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
      deviceStartCalls++;
      await deviceStartGate;
      if (deviceStartMode === "server-error")
        return Response.json({ error: "device_start_server_error_fake" }, { status: 503 });
      return Response.json({
        device_auth_id: "device_auth_workerd_fake",
        user_code: "WORKERD-FAKE",
        interval: 0,
      });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      devicePollCalls++;
      await devicePollGate;
      if (devicePollMode === "denied")
        return Response.json({ error: "access_denied" }, { status: 403 });
      if (devicePollMode === "expired")
        return Response.json({ error: "expired_token" }, { status: 404 });
      if (devicePollMode === "pending")
        return Response.json({ error: "authorization_pending" }, { status: 403 });
      if (devicePollMode === "rate-limited")
        return Response.json({ error: "slow_down" }, {
          status: 429,
          headers: { "Retry-After": "2" },
        });
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
        if (refreshMode === "erroring-body") {
          const body = new ReadableStream({
            start(controller) {
              controller.error(new Error("fake refresh response body failure"));
            },
          });
          return new Response(body, { status: 429 });
        }
        return Response.json(fakeCredential(refreshCalls + 1, 3600));
      }
      exchangeCalls++;
      await exchangeGate;
      if (exchangeMode === "malformed") return Response.json({ access_token: "malformed_fake" });
      if (exchangeMode === "server-error")
        return Response.json({ error: "server_error_fake" }, { status: 503 });
      return Response.json(fakeCredential(1, initialExpiresIn));
    }
    if (url.pathname === "/backend-api/codex/responses") {
      inferenceCalls++;
      lastInferenceUrl = request.url;
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
              if (streamBytesProduced >= streamTotalBytes) {
                streamProductionCompletedAt = Date.now();
                controller.close();
              }
            } finally {
              streamActivePulls--;
            }
          },
        });
        streamBytesProducedAtHeaders = streamBytesProduced;
        return new Response(stream, { headers: { "Content-Type": "application/octet-stream" } });
      }
      if (streamMode === "timed") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            firstByteTimestamps.push(Date.now());
            controller.enqueue(new TextEncoder().encode("data: fake-timed-first-byte\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
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
          cancellationTimestamps.push(Date.now());
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
    releaseDeviceStartGate?.();
    releaseDevicePollGate?.();
    releaseExchangeGate?.();
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
    lastInferenceUrl = "";
    exchangeMode = "success";
    refreshMode = "success";
    refreshRetryAfterSeconds = 1;
    streamTotalBytes = 0;
    streamChunkBytes = 0;
    streamBytesProduced = 0;
    streamBytesProducedAtHeaders = 0;
    streamProductionCompletedAt = 0;
    streamActivePulls = 0;
    streamMaxActivePulls = 0;
    firstByteTimestamps = [];
    cancellationTimestamps = [];
    deviceStartMode = "success";
    devicePollMode = "authorized";
    deviceStartCalls = 0;
    devicePollCalls = 0;
    deviceStartGate = undefined;
    releaseDeviceStartGate = undefined;
    devicePollGate = undefined;
    releaseDevicePollGate = undefined;
    exchangeGate = undefined;
    releaseExchangeGate = undefined;
  }

  setInitialExpiresIn(seconds: number): void {
    initialExpiresIn = seconds;
  }

  setExchangeMode(mode: ExchangeMode): void {
    exchangeMode = mode;
  }

  setDeviceStartMode(mode: DeviceStartMode): void {
    deviceStartMode = mode;
  }

  setDevicePollMode(mode: DevicePollMode): void {
    devicePollMode = mode;
  }

  blockDeviceStart(): void {
    deviceStartGate = new Promise((resolve) => { releaseDeviceStartGate = resolve });
  }

  releaseDeviceStart(): void {
    releaseDeviceStartGate?.();
    deviceStartGate = undefined;
    releaseDeviceStartGate = undefined;
  }

  blockDevicePoll(): void {
    devicePollGate = new Promise((resolve) => { releaseDevicePollGate = resolve });
  }

  releaseDevicePoll(): void {
    releaseDevicePollGate?.();
    devicePollGate = undefined;
    releaseDevicePollGate = undefined;
  }

  blockExchange(): void {
    exchangeGate = new Promise((resolve) => { releaseExchangeGate = resolve });
  }

  releaseExchange(): void {
    releaseExchangeGate?.();
    exchangeGate = undefined;
    releaseExchangeGate = undefined;
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
    streamBytesProducedAtHeaders = 0;
    streamProductionCompletedAt = 0;
    streamActivePulls = 0;
    streamMaxActivePulls = 0;
  }

  clearPerformanceSamples(): void {
    firstByteTimestamps = [];
    cancellationTimestamps = [];
  }

  rejectNextInferenceAsUnauthorized(): void {
    unauthorizedOnce = true;
  }

  async waitForRefreshCalls(count: number): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- fetch() updates module state.
    while (refreshCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForDeviceStartCalls(count: number): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- fetch() updates module state.
    while (deviceStartCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForDevicePollCalls(count: number): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- fetch() updates module state.
    while (devicePollCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForExchangeCalls(count: number): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- fetch() updates module state.
    while (exchangeCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForStreamCancellation(): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- stream cancellation updates module state.
    while (streamCancellations === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  readPerformanceSamples(): {
    firstByteTimestamps: number[];
    cancellationTimestamps: number[];
  } {
    return {
      firstByteTimestamps: [...firstByteTimestamps],
      cancellationTimestamps: [...cancellationTimestamps],
    };
  }

  read(): {
    exchangeCalls: number;
    refreshCalls: number;
    inferenceCalls: number;
    streamCancellations: number;
    lastInferenceHeaders: Record<string, string>;
    lastInferenceBody: string;
    lastInferenceUrl: string;
    streamBytesProduced: number;
    streamBytesProducedAtHeaders: number;
    streamProductionCompletedAt: number;
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
      lastInferenceUrl,
      streamBytesProduced,
      streamBytesProducedAtHeaders,
      streamProductionCompletedAt,
      streamChunkBytes,
      streamMaxActivePulls,
    };
  }
}
