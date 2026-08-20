const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
};

/** Fake preview-only upstream; it never accepts or emits a real credential. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("not found", { status: 404 });

    if (url.pathname === "/backend-api/codex/responses") {
      const body = [
        'event: response.output_text.delta\ndata: {"delta":"fake preview response"}\n\n',
        'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n',
      ].join("");
      return new Response(body, { headers: SSE_HEADERS });
    }

    return Response.json({ error: "fake_endpoint_not_configured" }, { status: 404 });
  },
};
