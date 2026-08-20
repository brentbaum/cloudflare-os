export const CODEX_UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
export const MAX_INFERENCE_BODY_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_CODEX_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-luna"]);

const UNSUPPORTED_CONTENT_TYPES = new Set([
  "audio",
  "document",
  "file",
  "file_search",
  "input_audio",
  "input_file",
  "input_video",
  "pdf",
  "video",
]);
const UNSUPPORTED_KEYS = new Set(["audio_data", "file_data", "file_id", "video_data"]);

export class InferencePolicyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InferencePolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsUnsupportedMedia(value: unknown): boolean {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    if (
      typeof current.type === "string" &&
      UNSUPPORTED_CONTENT_TYPES.has(current.type.toLowerCase())
    ) {
      return true;
    }
    for (const [key, child] of Object.entries(current)) {
      if (UNSUPPORTED_KEYS.has(key.toLowerCase())) return true;
      if (typeof child === "string" && child.startsWith("data:")) {
        const mediaType = child
          .slice(5, child.indexOf(";") === -1 ? undefined : child.indexOf(";"))
          .toLowerCase();
        if (!mediaType.startsWith("image/")) return true;
      }
      stack.push(child);
    }
  }
  return false;
}

export type ValidatedInferenceRequest = {
  body: Uint8Array<ArrayBuffer>;
  model: string;
};

/** Validate and buffer the bounded JSON request so a pre-stream 401 retry is replay-safe. */
export async function validateInferenceRequest(
  request: Request,
): Promise<ValidatedInferenceRequest> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/backend-api/codex/responses") {
    throw new InferencePolicyError(
      404,
      "unsupported_endpoint",
      "Only the Codex Responses endpoint is available",
    );
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new InferencePolicyError(
      415,
      "unsupported_media_type",
      "Inference requests must be JSON",
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_INFERENCE_BODY_BYTES) {
    throw new InferencePolicyError(
      413,
      "request_too_large",
      "Inference request exceeds the size limit",
    );
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_INFERENCE_BODY_BYTES) {
    throw new InferencePolicyError(
      413,
      "request_too_large",
      "Inference request exceeds the size limit",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new InferencePolicyError(400, "invalid_json", "Inference request body is not valid JSON");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.model !== "string" ||
    !SUPPORTED_CODEX_MODELS.has(parsed.model)
  ) {
    throw new InferencePolicyError(
      400,
      "unsupported_model",
      "The requested Codex model is not enabled",
    );
  }
  if (parsed.stream !== true) {
    throw new InferencePolicyError(
      400,
      "streaming_required",
      "Codex relay requests must use SSE streaming",
    );
  }
  if (containsUnsupportedMedia(parsed)) {
    throw new InferencePolicyError(
      400,
      "unsupported_media",
      "Only text and image inputs are enabled",
    );
  }
  return { body, model: parsed.model };
}

/** Construct an upstream request from fixed values, never caller-supplied authority or credentials. */
export function createUpstreamRequest(
  body: Uint8Array<ArrayBufferLike>,
  credential: { accessToken: string; accountId: string },
  signal?: AbortSignal,
): Request {
  const requestBody = new Uint8Array(new ArrayBuffer(body.byteLength));
  requestBody.set(body);
  return new Request(CODEX_UPSTREAM_URL, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${credential.accessToken}`,
      "ChatGPT-Account-Id": credential.accountId,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      Originator: "pi",
      Version: "0.144.1",
    },
    body: requestBody,
    signal,
  });
}

const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "openai-processing-ms",
  "openai-version",
  "request-id",
  "retry-after",
  "x-request-id",
]);

/** Return an upstream response without buffering its body and with a strict header allowlist. */
export function sanitizeUpstreamResponse(response: Response): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function policyErrorResponse(error: InferencePolicyError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}
