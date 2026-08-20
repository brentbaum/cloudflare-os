import { describe, expect, it } from "vitest";
import { zstdCompressSync } from "node:zlib";
import {
  CODEX_UPSTREAM_URL,
  InferencePolicyError,
  MAX_INFERENCE_BODY_BYTES,
  createUpstreamRequest,
  policyErrorResponse,
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

async function policyError(body: unknown): Promise<InferencePolicyError> {
  const error = await validateInferenceRequest(
    request({ model: "gpt-5.6-luna", stream: true, ...(body as object) }),
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(InferencePolicyError);
  return error as InferencePolicyError;
}

function responseWithReader(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">,
): Response {
  const response = new Response(new ReadableStream<Uint8Array>());
  if (!response.body) throw new TypeError("Expected a response body");
  Object.defineProperty(response.body, "getReader", {
    configurable: true,
    value: () => reader,
  });
  return response;
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

  it("accepts every enabled request-shape branch", async () => {
    await expect(validateInferenceRequest(request({
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
      service_tier: "priority",
      temperature: 0,
      tool_choice: "none",
      parallel_tool_calls: false,
      input: [
        { role: "developer", content: "fake developer prompt" },
        { role: "system", content: "fake system prompt" },
        { type: "input_text", text: "direct fake text" },
        { type: "reasoning", id: "reasoning_without_summary_fake" },
        {
          type: "input_image",
          image_url: "data:image/webp;base64,ZmFrZQ==",
          detail: "high",
        },
        {
          type: "function_call_output",
          call_id: "call_parts_fake",
          id: "output_fake",
          status: "completed",
          output: [{ type: "input_text", text: "fake function output" }],
        },
      ],
      tools: [{
        type: "function",
        name: "fake_nullable_strict",
        description: "fake",
        parameters: {},
        strict: null,
      }],
    }))).resolves.toMatchObject({ model: "gpt-5.6-luna" });
  });

  it.each([
    ["stored responses", { store: true }],
    ["non-text instructions", { instructions: 7 }],
    ["non-text previous response id", { previous_response_id: 7 }],
    ["non-text cache key", { prompt_cache_key: 7 }],
    ["non-list input", { input: {} }],
    ["non-object input item", { input: [null] }],
    ["input message unknown key", { input: [{ role: "user", content: "fake", extra: true }] }],
    ["input message role", { input: [{ role: "assistant", content: "fake" }] }],
    ["input message content", { input: [{ role: "user", content: 7 }] }],
    ["content item without a type", { input: [{ role: "user", content: [{}] }] }],
    ["content item primitive", { input: [{ role: "user", content: [7] }] }],
    ["text input without text", { input: [{ type: "input_text" }] }],
    ["image detail", {
      input: [{ type: "input_image", image_url: "data:image/png;base64,ZmFrZQ==", detail: "full" }],
    }],
    ["assistant role", { input: [{ type: "message", role: "user", content: [] }] }],
    ["assistant content list", { input: [{ type: "message", role: "assistant", content: "fake" }] }],
    ["assistant content primitive", {
      input: [{ type: "message", role: "assistant", content: [7] }],
    }],
    ["assistant content type", {
      input: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }],
    }],
    ["assistant output unknown key", {
      input: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "fake", annotations: [], extra: true }],
      }],
    }],
    ["assistant output text", {
      input: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: 7, annotations: [] }],
      }],
    }],
    ["assistant output annotations type", {
      input: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "fake", annotations: null }],
      }],
    }],
    ["assistant output annotations", {
      input: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "fake", annotations: [{}] }],
      }],
    }],
    ["assistant id", { input: [{ type: "message", role: "assistant", id: 7, content: [] }] }],
    ["assistant status", {
      input: [{ type: "message", role: "assistant", status: 7, content: [] }],
    }],
    ["assistant phase", {
      input: [{ type: "message", role: "assistant", phase: "analysis", content: [] }],
    }],
    ["reasoning id", { input: [{ type: "reasoning", id: 7 }] }],
    ["encrypted reasoning", { input: [{ type: "reasoning", encrypted_content: 7 }] }],
    ["reasoning status", { input: [{ type: "reasoning", status: 7 }] }],
    ["reasoning summary list", { input: [{ type: "reasoning", summary: "fake" }] }],
    ["reasoning summary primitive", { input: [{ type: "reasoning", summary: [7] }] }],
    ["reasoning summary type", {
      input: [{ type: "reasoning", summary: [{ type: "other", text: "fake" }] }],
    }],
    ["reasoning summary unknown key", {
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "fake", extra: 1 }] }],
    }],
    ["reasoning summary text", {
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: 7 }] }],
    }],
    ["function call id", {
      input: [{ type: "function_call", call_id: 7, name: "fake", arguments: "{}" }],
    }],
    ["function call name", {
      input: [{ type: "function_call", call_id: "call_fake", name: 7, arguments: "{}" }],
    }],
    ["function call arguments", {
      input: [{ type: "function_call", call_id: "call_fake", name: "fake", arguments: 7 }],
    }],
    ["function call optional id", {
      input: [{
        type: "function_call", call_id: "call_fake", name: "fake", arguments: "{}", id: 7,
      }],
    }],
    ["function call optional status", {
      input: [{
        type: "function_call", call_id: "call_fake", name: "fake", arguments: "{}", status: 7,
      }],
    }],
    ["function output call id", {
      input: [{ type: "function_call_output", call_id: 7, output: "fake" }],
    }],
    ["function output content", {
      input: [{ type: "function_call_output", call_id: "call_fake", output: {} }],
    }],
    ["function output optional id", {
      input: [{ type: "function_call_output", call_id: "call_fake", output: "fake", id: 7 }],
    }],
    ["function output optional status", {
      input: [{ type: "function_call_output", call_id: "call_fake", output: "fake", status: 7 }],
    }],
    ["tools list", { tools: {} }],
    ["tool primitive", { tools: [7] }],
    ["tool type", { tools: [{ type: "web_search" }] }],
    ["tool unknown key", {
      tools: [{ type: "function", name: "fake", parameters: {}, extra: true }],
    }],
    ["tool name", { tools: [{ type: "function", name: 7, parameters: {} }] }],
    ["tool parameters", { tools: [{ type: "function", name: "fake", parameters: [] }] }],
    ["tool description", {
      tools: [{ type: "function", name: "fake", parameters: {}, description: 7 }],
    }],
    ["tool strict", {
      tools: [{ type: "function", name: "fake", parameters: {}, strict: "true" }],
    }],
    ["tool choice", { tool_choice: "fake" }],
    ["parallel tool calls", { parallel_tool_calls: "true" }],
    ["temperature", { temperature: "zero" }],
    ["reasoning settings", { reasoning: [] }],
    ["reasoning unknown key", { reasoning: { effort: "high", extra: true } }],
    ["reasoning effort", { reasoning: { effort: "ultra" } }],
    ["reasoning summary", { reasoning: { summary: "verbose" } }],
    ["text settings", { text: [] }],
    ["text unknown key", { text: { verbosity: "low", extra: true } }],
    ["text verbosity", { text: { verbosity: "maximum" } }],
    ["include list", { include: "reasoning.encrypted_content" }],
    ["include item", { include: ["reasoning.encrypted_content", "file_search_call.results"] }],
    ["service tier", { service_tier: "batch" }],
  ])("rejects invalid %s", async (_label, fragment) => {
    expect(await policyError(fragment)).toMatchObject({
      status: 400,
      code: "unsupported_capability",
    });
  });

  it("rejects a malformed image as unsupported media", async () => {
    expect(await policyError({
      input: [{ type: "input_image", image_url: 7 }],
    })).toMatchObject({ status: 400, code: "unsupported_media" });
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

  it("rejects non-POST requests even at the fixed path", async () => {
    const error = await validateInferenceRequest(new Request(CODEX_UPSTREAM_URL, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    })).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 404, code: "unsupported_endpoint" });
  });

  it.each([
    [undefined, "{}"],
    ["text/plain", "{}"],
  ])("rejects missing or non-JSON content type %#", async (contentType, body) => {
    const headers = contentType ? { "Content-Type": contentType } : undefined;
    const error = await validateInferenceRequest(new Request(CODEX_UPSTREAM_URL, {
      method: "POST",
      headers,
      body,
    })).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 415, code: "unsupported_media_type" });
  });

  it("accepts normalized JSON media type and an unparseable content length", async () => {
    await expect(validateInferenceRequest(request(
      { model: "gpt-5.6-sol", stream: true, input: "fake" },
      undefined,
      { "Content-Type": " APPLICATION/JSON ; charset=utf-8", "Content-Length": "not-a-number" },
    ))).resolves.toMatchObject({ model: "gpt-5.6-sol" });
  });

  it("rejects an advertised oversized request before reading its body", async () => {
    const oversized = request({ model: "gpt-5.6-sol", stream: true }, undefined, {
      "Content-Length": String(MAX_INFERENCE_BODY_BYTES + 1),
    });
    const error = await validateInferenceRequest(oversized).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 413, code: "request_too_large" });
  });

  it("rejects an oversized request without trusting the content-length header", async () => {
    const error = await validateInferenceRequest(new Request(CODEX_UPSTREAM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array(MAX_INFERENCE_BODY_BYTES + 1),
    })).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 413, code: "request_too_large" });
  });

  it("rejects invalid JSON and every invalid model envelope", async () => {
    const invalidJson = await validateInferenceRequest(new Request(CODEX_UPSTREAM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    })).catch((cause: unknown) => cause);
    expect(invalidJson).toMatchObject({ status: 400, code: "invalid_json" });

    for (const body of [null, [], {}, { model: 7, stream: true }]) {
      const error = await validateInferenceRequest(new Request(CODEX_UPSTREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status: 400, code: "unsupported_model" });
    }
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

  it("normalizes an explicit identity encoding", async () => {
    await expect(validateInferenceRequest(request(
      { model: "gpt-5.6-sol", stream: true, input: "fake" },
      undefined,
      { "Content-Encoding": " IDENTITY " },
    ))).resolves.toMatchObject({ model: "gpt-5.6-sol" });
  });

  it("rejects a small zstd envelope whose decoded body exceeds the limit", async () => {
    const compressed = zstdCompressSync(new Uint8Array(MAX_INFERENCE_BODY_BYTES + 1));
    const body = new Uint8Array(new ArrayBuffer(compressed.byteLength));
    body.set(compressed);
    const error = await validateInferenceRequest(new Request(CODEX_UPSTREAM_URL, {
      method: "POST",
      headers: { "Content-Encoding": "zstd", "Content-Type": "application/json" },
      body,
    })).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 413, code: "request_too_large" });
  });

  it("rebuilds upstream headers without caller auth, account, host, or cookies", () => {
    const controller = new AbortController();
    const upstream = createUpstreamRequest(
      new TextEncoder().encode('{"model":"gpt-5.6-sol","stream":true}'),
      { accessToken: "access_owned_fake", accountId: "account_owned_fake" },
      controller.signal,
    );
    expect(upstream.url).toBe(CODEX_UPSTREAM_URL);
    expect(upstream.headers.get("authorization")).toBe("Bearer access_owned_fake");
    expect(upstream.headers.get("chatgpt-account-id")).toBe("account_owned_fake");
    expect(upstream.headers.get("openai-beta")).toBe("responses=experimental");
    expect(upstream.headers.get("originator")).toBe("pi");
    expect(upstream.headers.get("content-encoding")).toBeNull();
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("host")).toBeNull();
    expect(upstream.signal.aborted).toBe(false);
    controller.abort("fake caller cancellation");
    expect(upstream.signal.aborted).toBe(true);
    expect(upstream.signal.reason).toBe("fake caller cancellation");
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

  it("finishes an ordinary response that has no explicit disposal hook", async () => {
    const sanitized = sanitizeUpstreamResponse(new Response("fake complete body", {
      status: 202,
      statusText: "Fake Accepted",
    }));
    expect(sanitized.status).toBe(202);
    expect(sanitized.statusText).toBe("Fake Accepted");
    await expect(sanitized.text()).resolves.toBe("fake complete body");
  });

  it("still disposes the response when releasing the upstream reader races settlement", async () => {
    const source = responseWithReader({
      async read() {
        return { done: true, value: undefined };
      },
      async cancel() {},
      releaseLock() {
        throw new Error("fake reader already settled");
      },
    });
    const disposal = trackDisposal(source);
    await expect(sanitizeUpstreamResponse(source).text()).resolves.toBe("");
    expect(disposal.count()).toBe(1);
  });

  it("suppresses an expected fake-reader read rejection only after downstream cancellation", async () => {
    let rejectRead!: (error: Error) => void;
    const source = responseWithReader({
      read() {
        return new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
      async cancel() {
        rejectRead(new Error("Operation was aborted"));
      },
      releaseLock() {},
    });
    const disposal = trackDisposal(source);
    const reader = sanitizeUpstreamResponse(source).body?.getReader();
    const pending = reader?.read();
    await Promise.resolve();
    await reader?.cancel("fake caller cancellation");
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(disposal.count()).toBe(1);
  });

  it("suppresses recognized upstream cancel failures", async () => {
    const source = responseWithReader({
      async read() {
        return { done: true, value: undefined };
      },
      async cancel() {
        throw new Error("ReadableStream received over RPC disconnected prematurely");
      },
      releaseLock() {},
    });
    const disposal = trackDisposal(source);
    await expect(sanitizeUpstreamResponse(source).body?.cancel()).resolves.toBeUndefined();
    expect(disposal.count()).toBe(1);
  });

  it.each([
    "fake string cancellation failure",
    { message: 7 },
    new Error("fake genuine cancellation failure"),
  ])("propagates an unrecognized upstream cancel failure %#", async (failure) => {
    const source = responseWithReader({
      async read() {
        return { done: true, value: undefined };
      },
      async cancel() {
        throw failure;
      },
      releaseLock() {},
    });
    const disposal = trackDisposal(source);
    await expect(sanitizeUpstreamResponse(source).body?.cancel()).rejects.toBe(failure);
    expect(disposal.count()).toBe(1);
  });

  it("disposes a bodyless upstream response immediately", () => {
    const source = new Response(null, { status: 204 });
    const disposal = trackDisposal(source);
    expect(sanitizeUpstreamResponse(source).status).toBe(204);
    expect(disposal.count()).toBe(1);
  });

  it("serializes only the stable policy error fields", async () => {
    const error = new InferencePolicyError(
      415,
      "fake_policy_code",
      "fake safe policy message",
    );
    Object.assign(error, { credential: "credential_must_not_leak_fake" });
    const response = policyErrorResponse(error);
    const raw = response.clone();
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "fake_policy_code",
        message: "fake safe policy message",
      },
    });
    await expect(raw.text()).resolves.not.toContain("credential_must_not_leak_fake");
  });
});
