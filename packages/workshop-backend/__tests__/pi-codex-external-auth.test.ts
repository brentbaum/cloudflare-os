import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Context,
  FetchFunction,
  Model,
  OpenAICodexResponsesOptions,
} from "@earendil-works/pi-ai";
import {
  stream as streamOpenAICodexResponses,
  streamSimple as streamSimpleOpenAICodexResponses,
} from "@earendil-works/pi-ai/api/openai-codex-responses";

const MODEL: Model<"openai-codex-responses"> = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

const CONTEXT: Context = {
  messages: [{ role: "user", content: "Say hello.", timestamp: 0 }],
};

function fakeBearer(accountId = "unmistakably-fake-account"): string {
  const payload = btoa(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  }));
  return `not-a-jwt.${payload}.not-a-signature`;
}

function completedSse(text = "Hello"): string {
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "unmistakably-fake-message",
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
        id: "unmistakably-fake-message",
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
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n` +
      "data: [DONE]\n\n";
}

function sseResponse(text = "Hello"): Response {
  return new Response(completedSse(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function externalOptions(
  options: Omit<OpenAICodexResponsesOptions, "apiKey"> = {},
): OpenAICodexResponsesOptions & { authorization: { mode: "external" } } {
  return {
    ...options,
    authorization: { mode: "external" },
  };
}

function stubAmbientFetch() {
  const ambientFetch = vi.fn<FetchFunction>(async () => {
    throw new Error("ambient fetch must not be called");
  });
  vi.stubGlobal("fetch", ambientFetch);
  return ambientFetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pi Codex external authorization contract", () => {
  it("preserves legacy bearer headers while using the injected SSE fetch", async () => {
    const ambientFetch = stubAmbientFetch();
    const token = fakeBearer();
    let request: Request | undefined;
    const injectedFetch = vi.fn<FetchFunction>(async (input, init) => {
      request = new Request(input, init);
      return sseResponse();
    });

    const result = await streamOpenAICodexResponses(MODEL, CONTEXT, {
      apiKey: token,
      fetch: injectedFetch,
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(request?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request?.headers.get("chatgpt-account-id")).toBe("unmistakably-fake-account");
    expect(request?.headers.get("accept")).toBe("text/event-stream");
    expect(injectedFetch).toHaveBeenCalledOnce();
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("streams semantic SSE through streamSimple without emitting auth headers", async () => {
    const ambientFetch = stubAmbientFetch();
    let request: Request | undefined;
    const injectedFetch = vi.fn<FetchFunction>(async (input, init) => {
      request = new Request(input, init);
      return sseResponse("External hello");
    });

    const modelWithStaleAuth = {
      ...MODEL,
      headers: {
        Authorization: "must-be-removed-from-model-headers",
        "chatgpt-account-id": "must-be-removed-from-model-headers",
      },
    } satisfies Model<"openai-codex-responses">;
    const result = await streamSimpleOpenAICodexResponses(
      modelWithStaleAuth,
      CONTEXT,
      externalOptions({
        fetch: injectedFetch,
        headers: {
          Authorization: "must-be-removed-from-call-headers",
          "chatgpt-account-id": "must-be-removed-from-call-headers",
        },
      }),
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({
      type: "text",
      text: "External hello",
    }));
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("chatgpt-account-id")).toBeNull();
    expect(request?.headers.get("accept")).toBe("text/event-stream");
    expect(injectedFetch).toHaveBeenCalledOnce();
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch without a non-ambient injected fetch", async () => {
    const ambientFetch = stubAmbientFetch();

    for (const options of [externalOptions(), externalOptions({ fetch: ambientFetch })]) {
      const result = await streamOpenAICodexResponses(MODEL, CONTEXT, options).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("requires a custom fetch");
    }
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("rejects an explicit non-SSE transport before dispatch", async () => {
    const ambientFetch = stubAmbientFetch();
    const injectedFetch = vi.fn<FetchFunction>(async () => sseResponse());

    const result = await streamOpenAICodexResponses(
      MODEL,
      CONTEXT,
      externalOptions({ fetch: injectedFetch, transport: "websocket" }),
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("only supports the SSE transport");
    expect(injectedFetch).not.toHaveBeenCalled();
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation through the injected fetch", async () => {
    const ambientFetch = stubAmbientFetch();
    const controller = new AbortController();
    let dispatchedSignal: AbortSignal | null | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const injectedFetch = vi.fn<FetchFunction>(async (_input, init) => {
      dispatchedSignal = init?.signal;
      markFetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });

    const stream = streamOpenAICodexResponses(
      MODEL,
      CONTEXT,
      externalOptions({ fetch: injectedFetch, signal: controller.signal }),
    );
    await fetchStarted;
    controller.abort(new DOMException("unmistakably fake cancellation", "AbortError"));
    const result = await stream.result();

    expect(result.stopReason).toBe("aborted");
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(injectedFetch).toHaveBeenCalledOnce();
    expect(ambientFetch).not.toHaveBeenCalled();
  });
});
