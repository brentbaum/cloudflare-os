import { CODEX_UPSTREAM_URL } from "./policy.js";

const CODEX_EGRESS_URL = "http://codex-egress.internal/backend-api/codex/responses";

type FetchBinding = {
  fetch(request: Request): Promise<Response>;
};

/**
 * Route inference through an optional private VPC Service while preserving direct egress as the
 * deployment-independent default. The VPC Service itself pins the tunnel, host, and port; this
 * adapter additionally pins the only path the loopback egress host accepts.
 */
export function createInferenceFetch(
  binding?: FetchBinding,
  fallback: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    if (!binding) return fallback(request);
    if (request.url !== CODEX_UPSTREAM_URL) {
      return Promise.reject(new Error("Codex inference egress rejected an unexpected URL"));
    }
    return binding.fetch(new Request(CODEX_EGRESS_URL, request));
  };
}
