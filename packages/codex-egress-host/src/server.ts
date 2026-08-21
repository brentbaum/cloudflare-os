import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const CODEX_PATH = "/backend-api/codex/responses";
const CODEX_UPSTREAM_URL = `https://chatgpt.com${CODEX_PATH}`;
const DEFAULT_PORT = 8790;

const REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "chatgpt-account-id",
  "content-type",
  "openai-beta",
  "originator",
  "user-agent",
  "version",
]);

const RESPONSE_HEADERS = new Set([
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-request-id",
]);

type FetchWithDuplex = (
  input: string | URL | Request,
  init?: RequestInit & { duplex?: "half" },
) => Promise<Response>;

export type CodexEgressServerOptions = {
  fetchImpl?: FetchWithDuplex;
};

function allowedRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function allowedResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (RESPONSE_HEADERS.has(name)) headers[name] = value;
  }
  return headers;
}

function writePlain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

async function proxyCodex(
  request: IncomingMessage,
  response: ServerResponse,
  fetchImpl: FetchWithDuplex,
): Promise<void> {
  const abort = new AbortController();
  const abortUpstream = () => abort.abort();
  request.once("aborted", abortUpstream);
  response.once("close", () => {
    if (!response.writableEnded) abortUpstream();
  });

  try {
    const upstream = await fetchImpl(CODEX_UPSTREAM_URL, {
      method: "POST",
      headers: allowedRequestHeaders(request),
      body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
      duplex: "half",
      signal: abort.signal,
    });
    response.writeHead(upstream.status, allowedResponseHeaders(upstream));
    if (upstream.body === null) {
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch {
    if (!response.headersSent) writePlain(response, 502, "Codex upstream unavailable");
    else response.destroy();
  } finally {
    request.off("aborted", abortUpstream);
  }
}

/** Create a loopback-oriented, fixed-destination streaming Codex egress server. */
export function createCodexEgressServer(options: CodexEgressServerOptions = {}): Server {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchWithDuplex);
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://codex-egress.internal");
    if (request.method === "GET" && url.pathname === "/health") {
      writePlain(response, 200, "ok");
      return;
    }
    if (request.method !== "POST" || url.pathname !== CODEX_PATH || url.search.length > 0) {
      writePlain(response, 404, "Not found");
      return;
    }
    void proxyCodex(request, response, fetchImpl);
  });
}

async function main(): Promise<void> {
  const rawPort = process.env.CODEX_EGRESS_PORT;
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_EGRESS_PORT must be an integer from 1 through 65535");
  }
  const server = createCodexEgressServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Codex egress listening on 127.0.0.1:${port}`);
  });
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
