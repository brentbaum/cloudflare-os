import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexEgressServer } from "../src/server.js";

let server: Server | undefined;

async function listen(
  fetchImpl?: NonNullable<Parameters<typeof createCodexEgressServer>[0]>["fetchImpl"],
) {
  server = createCodexEgressServer({ fetchImpl });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current?.listening) await new Promise<void>((resolve) => current.close(() => resolve()));
});

describe("Codex egress host", () => {
  it("serves a credential-free loopback health check", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const origin = await listen(fetchImpl);
    const response = await fetch(`${origin}/health`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects methods, paths, and query strings outside the fixed route", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const origin = await listen(fetchImpl);

    expect((await fetch(`${origin}/backend-api/codex/responses`)).status).toBe(404);
    expect((await fetch(`${origin}/other`, { method: "POST" })).status).toBe(404);
    expect(
      (await fetch(`${origin}/backend-api/codex/responses?target=other`, { method: "POST" })).status,
    ).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("streams only allowlisted request and response metadata to the fixed upstream", async () => {
    let upstreamRequest: Request | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      upstreamRequest = new Request(input, init);
      return new Response("data: fake-egress\n\n", {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Set-Cookie": "never-forward_fake",
          "X-Request-Id": "request_fake",
        },
      });
    });
    const origin = await listen(fetchImpl);
    const response = await fetch(`${origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token_fake",
        "ChatGPT-Account-Id": "account_fake",
        "Content-Type": "application/json",
        Cookie: "cookie_fake",
        "X-Untrusted": "untrusted_fake",
      },
      body: '{"stream":true}',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: fake-egress\n\n");
    expect(response.headers.get("x-request-id")).toBe("request_fake");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(upstreamRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer token_fake");
    expect(upstreamRequest?.headers.get("chatgpt-account-id")).toBe("account_fake");
    expect(upstreamRequest?.headers.has("cookie")).toBe(false);
    expect(upstreamRequest?.headers.has("x-untrusted")).toBe(false);
    expect(await upstreamRequest?.text()).toBe('{"stream":true}');
  });

  it("returns a generic error without exposing upstream failure details", async () => {
    const origin = await listen(async () => {
      throw new Error("sensitive_fake_detail");
    });
    const response = await fetch(`${origin}/backend-api/codex/responses`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Codex upstream unavailable");
  });
});
