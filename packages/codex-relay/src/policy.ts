import { zstdDecompressSync } from "node:zlib";

export const CODEX_UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
export const MAX_INFERENCE_BODY_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_CODEX_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-luna"]);

const TOP_LEVEL_KEYS = new Set([
  "include",
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "service_tier",
  "store",
  "stream",
  "temperature",
  "text",
  "tool_choice",
  "tools",
]);
const MESSAGE_KEYS = new Set(["content", "role"]);
const INPUT_TEXT_KEYS = new Set(["text", "type"]);
const INPUT_IMAGE_KEYS = new Set(["detail", "image_url", "type"]);
const ASSISTANT_MESSAGE_KEYS = new Set(["content", "id", "phase", "role", "status", "type"]);
const OUTPUT_TEXT_KEYS = new Set(["annotations", "text", "type"]);
const REASONING_ITEM_KEYS = new Set(["encrypted_content", "id", "status", "summary", "type"]);
const SUMMARY_TEXT_KEYS = new Set(["text", "type"]);
const FUNCTION_CALL_KEYS = new Set(["arguments", "call_id", "id", "name", "status", "type"]);
const FUNCTION_OUTPUT_KEYS = new Set(["call_id", "id", "output", "status", "type"]);
const FUNCTION_TOOL_KEYS = new Set(["description", "name", "parameters", "strict", "type"]);

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

function rejectCapability(message: string): never {
  throw new InferencePolicyError(400, "unsupported_capability", message);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) rejectCapability(`${label} field ${unknown} is not enabled`);
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") rejectCapability(`${label} must be text`);
}

function validateInputContent(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string")
    rejectCapability("Input content must use an enabled content type");
  if (value.type === "input_text") {
    assertOnlyKeys(value, INPUT_TEXT_KEYS, "Text input");
    if (typeof value.text !== "string") rejectCapability("Text input must contain text");
    return;
  }
  if (value.type === "input_image") {
    assertOnlyKeys(value, INPUT_IMAGE_KEYS, "Image input");
    if (
      typeof value.image_url !== "string" ||
      !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]*$/i.test(value.image_url)
    ) {
      throw new InferencePolicyError(
        400,
        "unsupported_media",
        "Image inputs must be embedded image data",
      );
    }
    if (value.detail !== undefined && !["auto", "low", "high"].includes(String(value.detail)))
      rejectCapability("Image detail is not enabled");
    return;
  }
  throw new InferencePolicyError(
    400,
    "unsupported_media",
    "Only text and image inputs are enabled",
  );
}

function validateContentArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) rejectCapability(`${label} content must be a list`);
  for (const content of value) validateInputContent(content);
}

function validateInputItem(value: unknown): void {
  if (!isRecord(value)) rejectCapability("Input items must be objects");
  if (value.type === undefined) {
    assertOnlyKeys(value, MESSAGE_KEYS, "Input message");
    if (!["developer", "system", "user"].includes(String(value.role)))
      rejectCapability("Input message role is not enabled");
    if (typeof value.content !== "string") validateContentArray(value.content, "Input message");
    return;
  }
  if (value.type === "message") {
    assertOnlyKeys(value, ASSISTANT_MESSAGE_KEYS, "Assistant message");
    if (value.role !== "assistant") rejectCapability("Only assistant replay messages are enabled");
    if (!Array.isArray(value.content)) rejectCapability("Assistant message content must be a list");
    for (const content of value.content) {
      if (!isRecord(content) || content.type !== "output_text")
        rejectCapability("Only output text can be replayed from an assistant message");
      assertOnlyKeys(content, OUTPUT_TEXT_KEYS, "Assistant output text");
      if (typeof content.text !== "string" || !Array.isArray(content.annotations))
        rejectCapability("Assistant output text is invalid");
      if (content.annotations.length !== 0)
        rejectCapability("Assistant output annotations are not enabled");
    }
    assertOptionalString(value.id, "Assistant message id");
    assertOptionalString(value.status, "Assistant message status");
    if (value.phase !== undefined && value.phase !== "commentary" && value.phase !== "final_answer")
      rejectCapability("Assistant message phase is not enabled");
    return;
  }
  if (value.type === "reasoning") {
    assertOnlyKeys(value, REASONING_ITEM_KEYS, "Reasoning item");
    assertOptionalString(value.id, "Reasoning id");
    assertOptionalString(value.encrypted_content, "Encrypted reasoning");
    assertOptionalString(value.status, "Reasoning status");
    if (value.summary !== undefined) {
      if (!Array.isArray(value.summary)) rejectCapability("Reasoning summary must be a list");
      for (const summary of value.summary) {
        if (!isRecord(summary) || summary.type !== "summary_text")
          rejectCapability("Reasoning summary type is not enabled");
        assertOnlyKeys(summary, SUMMARY_TEXT_KEYS, "Reasoning summary");
        if (typeof summary.text !== "string") rejectCapability("Reasoning summary is invalid");
      }
    }
    return;
  }
  if (value.type === "function_call") {
    assertOnlyKeys(value, FUNCTION_CALL_KEYS, "Function call");
    if (
      typeof value.call_id !== "string" ||
      typeof value.name !== "string" ||
      typeof value.arguments !== "string"
    )
      rejectCapability("Function call replay is invalid");
    assertOptionalString(value.id, "Function call id");
    assertOptionalString(value.status, "Function call status");
    return;
  }
  if (value.type === "function_call_output") {
    assertOnlyKeys(value, FUNCTION_OUTPUT_KEYS, "Function output");
    if (typeof value.call_id !== "string") rejectCapability("Function output call id is invalid");
    if (typeof value.output !== "string") validateContentArray(value.output, "Function output");
    assertOptionalString(value.id, "Function output id");
    assertOptionalString(value.status, "Function output status");
    return;
  }
  if (value.type === "input_text" || value.type === "input_image") {
    validateInputContent(value);
    return;
  }
  rejectCapability(`Input item type ${String(value.type)} is not enabled`);
}

function validateTools(value: unknown): void {
  if (!Array.isArray(value)) rejectCapability("Tools must be a list");
  for (const tool of value) {
    if (!isRecord(tool) || tool.type !== "function")
      rejectCapability("Only function tools are enabled");
    assertOnlyKeys(tool, FUNCTION_TOOL_KEYS, "Function tool");
    if (typeof tool.name !== "string" || !isRecord(tool.parameters))
      rejectCapability("Function tool definition is invalid");
    assertOptionalString(tool.description, "Function tool description");
    if (tool.strict !== undefined && tool.strict !== null && typeof tool.strict !== "boolean")
      rejectCapability("Function tool strict mode is invalid");
    // `parameters` is declarative JSON Schema, not a provider capability object. Its nested `type`
    // and arbitrary schema keywords are intentionally not interpreted as request features.
  }
}

function validateRequestShape(value: Record<string, unknown>): void {
  assertOnlyKeys(value, TOP_LEVEL_KEYS, "Request");
  if (value.store !== undefined && value.store !== false)
    rejectCapability("Stored provider responses are not enabled");
  assertOptionalString(value.instructions, "Instructions");
  assertOptionalString(value.previous_response_id, "Previous response id");
  assertOptionalString(value.prompt_cache_key, "Prompt cache key");
  if (value.input !== undefined && typeof value.input !== "string") {
    if (!Array.isArray(value.input)) rejectCapability("Input must be text or a list");
    for (const item of value.input) validateInputItem(item);
  }
  if (value.tools !== undefined) validateTools(value.tools);
  if (
    value.tool_choice !== undefined &&
    !["auto", "none", "required"].includes(String(value.tool_choice))
  )
    rejectCapability("Tool choice is not enabled");
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean")
    rejectCapability("Parallel tool selection is invalid");
  if (value.temperature !== undefined && typeof value.temperature !== "number")
    rejectCapability("Temperature is invalid");
  if (value.reasoning !== undefined) {
    if (!isRecord(value.reasoning)) rejectCapability("Reasoning settings are invalid");
    assertOnlyKeys(value.reasoning, new Set(["effort", "summary"]), "Reasoning");
    if (
      value.reasoning.effort !== undefined &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        String(value.reasoning.effort),
      )
    )
      rejectCapability("Reasoning effort is not enabled");
    if (
      value.reasoning.summary !== undefined &&
      !["auto", "concise", "detailed", "off", "on"].includes(String(value.reasoning.summary))
    )
      rejectCapability("Reasoning summary is not enabled");
  }
  if (value.text !== undefined) {
    if (!isRecord(value.text)) rejectCapability("Text settings are invalid");
    assertOnlyKeys(value.text, new Set(["verbosity"]), "Text");
    if (!["low", "medium", "high"].includes(String(value.text.verbosity)))
      rejectCapability("Text verbosity is not enabled");
  }
  if (value.include !== undefined) {
    if (
      !Array.isArray(value.include) ||
      value.include.some((item) => item !== "reasoning.encrypted_content")
    )
      rejectCapability("Requested response expansions are not enabled");
  }
  if (
    value.service_tier !== undefined &&
    !["auto", "default", "flex", "priority"].includes(String(value.service_tier))
  )
    rejectCapability("Service tier is not enabled");
}

export type ValidatedInferenceRequest = {
  body: Uint8Array<ArrayBuffer>;
  model: string;
};

async function decodeInferenceBody(
  compressed: Uint8Array<ArrayBuffer>,
  contentEncoding: string | null,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoding = contentEncoding?.trim().toLowerCase() || "identity";
  if (encoding === "identity") return compressed;
  if (encoding !== "zstd") {
    throw new InferencePolicyError(
      415,
      "unsupported_content_encoding",
      "Inference request content encoding is not enabled",
    );
  }
  try {
    // `node:zlib` is provided by Workerd's nodejs_compat layer. maxOutputLength applies during
    // decompression, so a small zstd payload cannot allocate an unbounded result before rejection.
    const decoded = zstdDecompressSync(compressed, {
      maxOutputLength: MAX_INFERENCE_BODY_BYTES,
    });
    const body = new Uint8Array(new ArrayBuffer(decoded.byteLength));
    body.set(decoded);
    return body;
  } catch (error) {
    if (error instanceof InferencePolicyError) throw error;
    const decompressionCode = isRecord(error) ? error.code : undefined;
    const decompressionMessage = isRecord(error) ? error.message : undefined;
    if (
      decompressionCode === "ERR_BUFFER_TOO_LARGE" ||
      (typeof decompressionMessage === "string" &&
        /larger than|maxoutputlength|too large|output limit|memory limit/i.test(
          decompressionMessage,
        ))
    ) {
      throw new InferencePolicyError(
        413,
        "request_too_large",
        "Inference request exceeds the size limit",
      );
    }
    throw new InferencePolicyError(
      400,
      "invalid_compressed_body",
      "Inference request body is not valid zstd",
    );
  }
}

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
  const compressedBody = new Uint8Array(await request.arrayBuffer());
  if (compressedBody.byteLength > MAX_INFERENCE_BODY_BYTES) {
    throw new InferencePolicyError(
      413,
      "request_too_large",
      "Inference request exceeds the size limit",
    );
  }
  // The relay normalizes accepted input to identity encoding before both validation and upstream
  // forwarding. This prevents a caller-controlled encoding header from disagreeing with the body.
  const body = await decodeInferenceBody(compressedBody, request.headers.get("content-encoding"));
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
  validateRequestShape(parsed);
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
  const upstream = response.body?.getReader();
  let downstreamCancelled = false;
  const isCancellationFailure = (error: unknown) => {
    if (!isRecord(error) || typeof error.message !== "string") return false;
    return /stream was cancel(?:l)?ed|operation was aborted|request was aborted|readablestream received over rpc disconnected prematurely/i.test(
      error.message,
    );
  };
  // A zero-high-water-mark stream avoids speculative reads after each SSE chunk. It still creates
  // an explicit cancellation edge so a downstream RPC consumer closes the service-binding body.
  const body = upstream
    ? new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const result = await upstream.read();
              if (result.done) controller.close();
              else controller.enqueue(result.value);
            } catch (error) {
              // reader.cancel() rejects an already-pending cross-RPC read. The downstream stream is
              // already canceled in that case, so surfacing the expected rejection is unhandled.
              if (downstreamCancelled && isCancellationFailure(error)) return;
              controller.error(error);
            }
          },
          async cancel(reason) {
            downstreamCancelled = true;
            try {
              await upstream.cancel(reason);
            } catch (error) {
              if (!isCancellationFailure(error)) throw error;
            }
          },
        },
        { highWaterMark: 0 },
      )
    : null;
  return new Response(body, {
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
