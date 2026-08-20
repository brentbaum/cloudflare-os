import { WorkerEntrypoint } from "cloudflare:workers";
import { CodexRelay as ValidatedCodexRelay } from "../../codex-relay/.wrangler/validate/src/index.js";

// Keep these exports explicit: the Workers Vitest integration statically discovers entrypoints
// from this file and does not follow `export *` when it constructs `ctx.exports`.
export {
  default,
  AdminSettings,
  AgentSelfLoopback,
  AgentSpawnerGatekeeper,
  CodeModeTailLoopback,
  ExternalMessageGateway,
  GadgetTailLoopback,
  GatekeeperConnectCallbackImpl,
  GatekeeperHookLoopback,
  GatekeeperLoopback,
  LanguageModelGatekeeper,
  LoginConnectCallbackImpl,
  OverseerDurableObject,
  PendingLogin,
  TransientStubLoopback,
  UserDurableObject,
} from "../src/server.js";
// The dedicated test script builds the relay through capnweb-validate first. Importing that artifact
// keeps the cross-package test on the same validated RPC boundary as deployment; Vite deliberately
// does not transform decorator sources outside this package root.
export { CodexAuth } from "../../codex-relay/.wrangler/validate/src/index.js";

type StreamMode = "complete" | "cancellable";

let initialExpiresIn = 3600;
let refreshCalls = 0;
let inferenceCalls = 0;
let streamMode: StreamMode = "complete";
let streamCancellations = 0;
let refreshGate: Promise<void> | undefined;
let releaseRefreshGate: (() => void) | undefined;
let lastInferenceHeaders: Record<string, string> = {};
let inferenceBodies: Array<Record<string, unknown>> = [];
let relayRequestSignalAborted = false;

/** Real validated relay with test-only observation of the backend-to-relay request signal. */
export class CrossPackageCodexRelay extends ValidatedCodexRelay {
  override async infer(connection: string, request: Request): Promise<Response> {
    relayRequestSignalAborted = request.signal.aborted;
    request.signal.addEventListener("abort", () => {
      relayRequestSignalAborted = true;
    }, { once: true });
    return super.infer(connection, request);
  }

  readRequestSignalAborted(): boolean {
    return relayRequestSignalAborted;
  }
}

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
    access_token: fakeJwt("account_cross_package_fake", generation),
    refresh_token: `refresh_cross_package_fake_${generation}`,
    expires_in: expiresIn,
  };
}

function semanticSse(text = "Cross-package hello"): string {
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "message_cross_package_fake",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "message_cross_package_fake",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 3,
          total_tokens: 4,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n` +
    "data: [DONE]\n\n";
}

/** Test-only OAuth/Codex upstream for the backend-to-relay Workerd lifecycle test. */
export class CrossPackageCodexUpstream extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return Response.json({
        device_auth_id: "device_auth_cross_package_fake",
        user_code: "CROSS-PACKAGE-FAKE",
        interval: 0,
      });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      return Response.json({
        authorization_code: "authorization_code_cross_package_fake",
        code_verifier: "code_verifier_cross_package_fake",
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
      inferenceBodies.push(await request.json<Record<string, unknown>>());
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
              controller.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({
                  type: "response.output_item.added",
                  item: {
                    type: "message",
                    id: "message_cancellable_cross_package_fake",
                    role: "assistant",
                    status: "in_progress",
                    content: [],
                  },
                })}\n\n`,
              ));
              return;
            }
            await new Promise<void>((resolve) => {
              heartbeat = setTimeout(() => {
                heartbeat = undefined;
                controller.enqueue(new TextEncoder().encode(": cross-package-heartbeat\n\n"));
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
      return new Response(semanticSse(), {
        headers: {
          "Content-Type": "text/event-stream",
          "Set-Cookie": "must-not-cross=fake",
          "X-Request-Id": `request-cross-package-fake-${inferenceCalls}`,
        },
      });
    }
    return Response.json({ error: "unconfigured_cross_package_fake_path" }, { status: 404 });
  }

  reset(): void {
    releaseRefreshGate?.();
    initialExpiresIn = 3600;
    refreshCalls = 0;
    inferenceCalls = 0;
    streamMode = "complete";
    streamCancellations = 0;
    refreshGate = undefined;
    releaseRefreshGate = undefined;
    lastInferenceHeaders = {};
    inferenceBodies = [];
    relayRequestSignalAborted = false;
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

  async waitForRefreshCalls(count: number): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- fetch() updates module state.
    while (refreshCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForInferenceCalls(count: number): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- fetch() updates module state.
    while (inferenceCalls < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async waitForStreamCancellation(): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- stream cancellation updates module state.
    while (streamCancellations === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  read(): {
    refreshCalls: number;
    inferenceCalls: number;
    streamCancellations: number;
    lastInferenceHeaders: Record<string, string>;
    inferenceBodies: Array<Record<string, unknown>>;
  } {
    return {
      refreshCalls,
      inferenceCalls,
      streamCancellations,
      lastInferenceHeaders,
      inferenceBodies,
    };
  }
}
