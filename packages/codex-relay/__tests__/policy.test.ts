import { describe, expect, it } from "vitest";
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
      "unsupported_media",
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

  it("rejects every caller-selected path", async () => {
    const error = await validateInferenceRequest(
      request({ model: "gpt-5.6-sol", stream: true }, "/v1/responses"),
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 404, code: "unsupported_endpoint" });
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
    const sanitized = sanitizeUpstreamResponse(source);
    expect(sanitized.headers.get("set-cookie")).toBeNull();
    expect(sanitized.headers.get("x-unapproved")).toBeNull();
    expect(sanitized.headers.get("x-request-id")).toBe("request-fake");
    await expect(sanitized.text()).resolves.toBe("data: fake\n\n");
  });
});
