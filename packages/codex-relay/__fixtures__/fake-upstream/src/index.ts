const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
};

function fakeAccessToken(): string {
  const payload = btoa(JSON.stringify({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_unmistakably_fake_preview",
    },
  })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `fake-header.${payload}.fake-signature`;
}

function completedSse(): string {
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_unmistakably_fake_preview",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: "fake preview response" },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_unmistakably_fake_preview",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "fake preview response" }],
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

/** Fake preview-only upstream; it never accepts or emits a real credential. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("not found", { status: 404 });

    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return Response.json({
        device_auth_id: "device_auth_unmistakably_fake_preview",
        user_code: "FAKE-PREVIEW",
        interval: 1,
      });
    }

    if (url.pathname === "/api/accounts/deviceauth/token") {
      return Response.json({
        authorization_code: "authorization_unmistakably_fake_preview",
        code_verifier: "verifier_unmistakably_fake_preview",
      });
    }

    if (url.pathname === "/oauth/token") {
      return Response.json({
        access_token: fakeAccessToken(),
        refresh_token: "refresh_unmistakably_fake_preview",
        expires_in: 3600,
      });
    }

    if (url.pathname === "/backend-api/codex/responses") {
      if (!request.headers.get("authorization")?.startsWith("Bearer fake-header.")) {
        return Response.json({ error: "fake_missing_authorization" }, { status: 401 });
      }
      if (request.headers.get("chatgpt-account-id") !== "acct_unmistakably_fake_preview") {
        return Response.json({ error: "fake_missing_account" }, { status: 401 });
      }
      return new Response(completedSse(), { headers: SSE_HEADERS });
    }

    return Response.json({ error: "fake_endpoint_not_configured" }, { status: 404 });
  },
};
