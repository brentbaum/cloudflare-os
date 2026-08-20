import { describe, expect, it } from "vitest";
import { zstdCompressSync } from "node:zlib";
import {
  CODEX_UPSTREAM_URL,
  InferencePolicyError,
  createUpstreamRequest,
  sanitizeUpstreamResponse,
  validateInferenceRequest,
} from "../src/policy.js";

function request(
  body: unknown,
  path = "/backend-api/codex/responses",
  headers?: HeadersInit,
): Request {
  return new Request(`https://caller.invalid${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function trackDisposal(response: Response): { count: () => number } {
  let disposals = 0;
  const dispose = (Symbol as typeof Symbol & { readonly dispose: symbol }).dispose;
  Object.defineProperty(response, dispose, {
    configurable: true,
    value: () => { disposals++ },
  });
  return { count: () => disposals };
}

describe("inference policy", () => {
  it("accepts the fixed SSE text/image shape and buffers it for safe pre-stream replay", async () => {
    const validated = await validateInferenceRequest(
      request({
        model: "gpt-5.6-sol",
        stream: true,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "fake prompt" },
              { type: "input_image", image_url: "data:image/png;base64,ZmFrZQ==" },
            ],
          },
        ],
      }),
    );
    expect(validated.model).toBe("gpt-5.6-sol");
    expect(new TextDecoder().decode(validated.body)).toContain("fake prompt");
  });

  it.each([
    [{ model: "gpt-unsupported-fake", stream: true }, "unsupported_model"],
    [{ model: "gpt-5.6-luna", stream: false }, "streaming_required"],
    [
      {
        model: "gpt-5.6-luna",
        stream: true,
        input: [{ type: "input_file", file_id: "file_fake" }],
      },
      "unsupported_capability",
    ],
    [
      {
        model: "gpt-5.6-luna",
        stream: true,
        input: [{ type: "input_image", image_url: "data:application/pdf;base64,ZmFrZQ==" }],
      },
      "unsupported_media",
    ],
  ])("rejects unsupported request capability %#", async (body, code) => {
    const error = await validateInferenceRequest(request(body)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InferencePolicyError);
    expect(error).toMatchObject({ code });
  });

  it("accepts bounded Pi zstd input and normalizes it to identity JSON", async () => {
    const json = JSON.stringify({
      model: "gpt-5.6-sol",
      stream: true,
      input: "fake compressed prompt",
    });
    const compressed = zstdCompressSync(new TextEncoder().encode(json));
    const body = new Uint8Array(new ArrayBuffer(compressed.byteLength));
    body.set(compressed);
    const validated = await validateInferenceRequest(
      new Request("https://caller.invalid/backend-api/codex/responses", {
        method: "POST",
        headers: {
          "Content-Encoding": "zstd",
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(new TextDecoder().decode(validated.body)).toBe(json);
  });

  it("accepts Pi reasoning, continuation, and function-tool replay without treating JSON Schema as a capability", async () => {
    await expect(
      validateInferenceRequest(
        request({
          model: "gpt-5.6-sol",
          store: false,
          stream: true,
          instructions: "fake system prompt",
          previous_response_id: "response_fake",
          prompt_cache_key: "cache_fake",
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "high", summary: "auto" },
          text: { verbosity: "low" },
          tool_choice: "auto",
          parallel_tool_calls: true,
          tools: [
            {
              type: "function",
              name: "fake_tool",
              description: "A fake function",
              parameters: {
                type: "object",
                properties: {
                  media_type: { type: "string", enum: ["audio", "file_search"] },
                },
              },
              strict: false,
            },
          ],
          input: [
            {
              type: "reasoning",
              id: "reasoning_fake",
              encrypted_content: "encrypted_fake",
              summary: [{ type: "summary_text", text: "fake summary" }],
            },
            {
              type: "message",
              id: "message_fake",
              role: "assistant",
              status: "completed",
              phase: "final_answer",
              content: [{ type: "output_text", text: "fake output", annotations: [] }],
            },
            {
              type: "function_call",
              id: "function_fake",
              call_id: "call_fake",
              name: "fake_tool",
              arguments: '{"media_type":"audio"}',
            },
            { type: "function_call_output", call_id: "call_fake", output: "fake result" },
          ],
        }),
      ),
    ).resolves.toMatchObject({ model: "gpt-5.6-sol" });
  });

  it.each([
    ["unknown top-level field", { web_search_options: {} }, "unsupported_capability"],
    ["provider web-search tool", { tools: [{ type: "web_search" }] }, "unsupported_capability"],
    [
      "computer capability input",
      { input: [{ type: "computer_call", action: {} }] },
      "unsupported_capability",
    ],
    [
      "audio content",
      { input: [{ role: "user", content: [{ type: "input_audio", audio: "fake" }] }] },
      "unsupported_media",
    ],
    [
      "nested message bypass",
      {
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "fake", file_id: "file_bypass_fake" }],
          },
        ],
      },
      "unsupported_capability",
    ],
    [
      "reasoning bypass",
      { input: [{ type: "reasoning", encrypted_content: "fake", web_search: true }] },
      "unsupported_capability",
    ],
  ])("rejects %s through the explicit schema", async (_name, fragment, code) => {
    const error = await validateInferenceRequest(
      request({ model: "gpt-5.6-luna", stream: true, ...fragment }),
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 400, code });
  });

  it("rejects every caller-selected path", async () => {
    const error = await validateInferenceRequest(
      request({ model: "gpt-5.6-sol", stream: true }, "/v1/responses"),
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 404, code: "unsupported_endpoint" });
  });

  it.each([
    ["br", "unsupported_content_encoding", 415],
    ["zstd", "invalid_compressed_body", 400],
  ])("rejects unsafe or invalid %s encoded input", async (encoding, code, status) => {
    const encoded = request({ model: "gpt-5.6-sol", stream: true, input: "fake" }, undefined, {
      "Content-Encoding": encoding,
    });
    const error = await validateInferenceRequest(encoded).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code, status });
  });

  it("rebuilds upstream headers without caller auth, account, host, or cookies", () => {
    const upstream = createUpstreamRequest(
      new TextEncoder().encode('{"model":"gpt-5.6-sol","stream":true}'),
      { accessToken: "access_owned_fake", accountId: "account_owned_fake" },
    );
    expect(upstream.url).toBe(CODEX_UPSTREAM_URL);
    expect(upstream.headers.get("authorization")).toBe("Bearer access_owned_fake");
    expect(upstream.headers.get("chatgpt-account-id")).toBe("account_owned_fake");
    expect(upstream.headers.get("openai-beta")).toBe("responses=experimental");
    expect(upstream.headers.get("originator")).toBe("pi");
    expect(upstream.headers.get("content-encoding")).toBeNull();
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("host")).toBeNull();
  });

  it("preserves the raw stream while dropping cookies and unapproved response headers", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: fake\n\n"));
        controller.close();
      },
    });
    const source = new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Set-Cookie": "credential=fake",
        "X-Request-Id": "request-fake",
        "X-Unapproved": "fake",
      },
    });
    const disposal = trackDisposal(source);
    const sanitized = sanitizeUpstreamResponse(source);
    expect(sanitized.headers.get("set-cookie")).toBeNull();
    expect(sanitized.headers.get("x-unapproved")).toBeNull();
    expect(sanitized.headers.get("x-request-id")).toBe("request-fake");
    await expect(sanitized.text()).resolves.toBe("data: fake\n\n");
    expect(disposal.count()).toBe(1);
  });

  it("propagates downstream cancellation to the upstream reader exactly once", async () => {
    let cancellations = 0;
    const source = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: fake\n\n"));
        },
        cancel() {
          cancellations++;
        },
      }),
    );
    const disposal = trackDisposal(source);
    const reader = sanitizeUpstreamResponse(source).body?.getReader();
    expect(await reader?.read()).toMatchObject({ done: false });
    await reader?.cancel();
    expect(cancellations).toBe(1);
    expect(disposal.count()).toBe(1);
  });

  it("suppresses only the expected rejection when cancellation races a pending read", async () => {
    let rejectPending!: (error: Error) => void;
    const source = new Response(
      new ReadableStream({
        pull() {
          return new Promise<void>((_resolve, reject) => {
            rejectPending = reject;
          });
        },
        cancel() {
          rejectPending(new Error("Stream was cancelled."));
        },
      }),
    );
    const disposal = trackDisposal(source);
    const reader = sanitizeUpstreamResponse(source).body?.getReader();
    const pending = reader?.read();
    await Promise.resolve();
    await reader?.cancel();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(disposal.count()).toBe(1);
  });

  it("propagates a genuine upstream stream failure", async () => {
    const source = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("fake genuine stream failure"));
        },
      }),
    );
    const disposal = trackDisposal(source);
    const reader = sanitizeUpstreamResponse(source).body?.getReader();
    await expect(reader?.read()).rejects.toThrow("fake genuine stream failure");
    expect(disposal.count()).toBe(1);
  });

  it("disposes a bodyless upstream response immediately", () => {
    const source = new Response(null, { status: 204 });
    const disposal = trackDisposal(source);
    expect(sanitizeUpstreamResponse(source).status).toBe(204);
    expect(disposal.count()).toBe(1);
  });
});
