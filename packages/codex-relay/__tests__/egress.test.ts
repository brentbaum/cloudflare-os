import { describe, expect, it, vi } from "vitest";
import { createInferenceFetch } from "../src/egress.js";
import { CODEX_UPSTREAM_URL } from "../src/policy.js";

describe("Codex inference egress adapter", () => {
  it("preserves direct inference when no VPC binding is configured", async () => {
    const fallback = vi.fn<typeof fetch>(async (request) =>
      Response.json({ url: new Request(request).url }),
    );
    const response = await createInferenceFetch(undefined, fallback)(CODEX_UPSTREAM_URL, {
      method: "POST",
      body: "{}",
    });

    expect(await response.json()).toEqual({ url: CODEX_UPSTREAM_URL });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("rewrites a fixed Codex request through the private VPC binding", async () => {
    let received: Request | undefined;
    const binding = {
      async fetch(request: Request) {
        received = request;
        return new Response("ok");
      },
    };
    const fallback = vi.fn<typeof fetch>();
    const signal = new AbortController().signal;
    const response = await createInferenceFetch(binding, fallback)(CODEX_UPSTREAM_URL, {
      method: "POST",
      headers: { Authorization: "Bearer token_fake", "Content-Type": "application/json" },
      body: '{"stream":true}',
      signal,
    });

    expect(await response.text()).toBe("ok");
    expect(fallback).not.toHaveBeenCalled();
    expect(received?.url).toBe("http://codex-egress.internal/backend-api/codex/responses");
    expect(received?.method).toBe("POST");
    expect(received?.headers.get("authorization")).toBe("Bearer token_fake");
    expect(await received?.text()).toBe('{"stream":true}');
  });

  it("fails closed instead of forwarding an unexpected authority", async () => {
    const binding = { fetch: vi.fn<(request: Request) => Promise<Response>>() };
    await expect(
      createInferenceFetch(binding)("https://example.com/backend-api/codex/responses"),
    ).rejects.toThrow("unexpected URL");
    expect(binding.fetch).not.toHaveBeenCalled();
  });
});
