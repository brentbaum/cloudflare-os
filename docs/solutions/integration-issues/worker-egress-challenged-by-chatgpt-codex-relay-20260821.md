---
module: Codex Subscription Relay
date: 2026-08-21
problem_type: integration_issue
component: assistant
symptoms:
  - "POST requests from a Cloudflare Worker to chatgpt.com/backend-api/codex/responses returned a Cloudflare challenge with HTTP 403"
  - "The same credential-free probe through Cloudflare AI Gateway received the same HTTP 403 challenge"
  - "The exact endpoint returned an API-shaped HTTP 405 from a local machine, proving the route was reachable outside Workers"
root_cause: config_error
resolution_type: code_fix
severity: high
related_components:
  - Cloudflare Workers
  - Cloudflare Tunnel
  - Workers VPC Services
  - Durable Objects
tags: [codex, chatgpt, cloudflare-workers, cloudflare-tunnel, vpc-service, egress]
---

# Troubleshooting: Worker egress is challenged by the ChatGPT Codex endpoint

## Problem

The private Codex subscription relay completed device authorization and stored a usable credential,
but real inference failed before OpenAI processed the request. Requests originating from the
Cloudflare Workers network received an HTTP 403 bot challenge from the ChatGPT Codex endpoint.

This was a post-implementation deployment spike. Authentication, refresh-token ownership,
request-policy enforcement, and streaming had already passed local and Workerd validation.

## Environment

- Module: Codex Subscription Relay
- Stage: Post-implementation live deployment spike
- Cloudflare runtime: Workers, Durable Objects, Tunnel, and VPC Services
- Wrangler: 4.120.0
- `cloudflared`: 2026.8.2
- Node.js: 24.2.0
- Date: 2026-08-21

## Symptoms

- Device authorization completed and the admin UI showed the shared Codex connection as ready.
- `POST https://chatgpt.com/backend-api/codex/responses` returned HTTP 403 with a Cloudflare
  challenge when the relay called it directly from a Worker.
- The challenge reported a synthetic Worker-origin IPv6 address rather than the operator's normal
  network address.
- A credential-free AI Gateway custom-provider probe received the same HTTP 403 response.
- A credential-free request to the same path from the local machine returned API-shaped HTTP 405,
  which demonstrated that ordinary machine egress reached the upstream application rather than the
  challenge page.

## What Didn't Work

**Direct Worker egress:** Keep all OAuth and inference traffic inside the relay Worker.

- **Why it failed:** The upstream challenge was based on the network origin of the request. The
  validated request shape and credential did not change that origin.

**Matching OMP/Pi headers:** Compare the existing OMP transport and add its stable `User-Agent`,
`Originator`, beta, and version headers.

- **Why it failed:** The relay already matched the important Codex request contract. Adding a stable
  Worker-specific user agent was useful for observability but did not change the upstream network
  classification.

**Cloudflare AI Gateway custom provider:** Route the same credential-free request through AI
Gateway.

- **Why it failed:** The request still left from Cloudflare infrastructure and received the same
  challenge. AI Gateway changed the application hop, not the egress trust boundary.

**Alternate ChatGPT hostname:** Try the legacy `chat.openai.com` authority.

- **Why it failed:** It redirects to `chatgpt.com`, so it does not provide an independent inference
  origin.

**Moving OAuth credential ownership:** Run an existing external auth broker as the new owner.

- **Why it was rejected:** Copying or competing for a rotating refresh token creates a split-brain
  credential race. The Durable Object was already the canonical owner and had to remain so.

## Solution

Keep the Durable Object as the sole credential and refresh-token owner, but give inference an
optional private egress transport:

```text
AgentOS
  -> private relay service binding
  -> CodexAuth Durable Object
  -> CODEX_EGRESS VPC Service binding
  -> remotely managed Cloudflare Tunnel
  -> loopback-only codex-egress-host
  -> https://chatgpt.com/backend-api/codex/responses
```

OAuth start, poll, exchange, and refresh continue to use direct Worker fetch because those paths
already work. Only the fully validated inference request crosses the VPC binding.

The relay uses a fixed internal URL when a VPC binding exists and preserves direct egress when it
does not:

```ts
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
    return binding.fetch(
      new Request("http://codex-egress.internal/backend-api/codex/responses", request),
    );
  };
}
```

The deployment binds that adapter to one VPC Service:

```jsonc
"vpc_services": [
  {
    "binding": "CODEX_EGRESS",
    "service_id": "<vpc-service-id>"
  }
]
```

The VPC Service is pinned to one named Tunnel, hostname `localhost`, and the loopback host's port.
The host itself:

- binds only to `127.0.0.1`;
- accepts only `GET /health` and `POST /backend-api/codex/responses`;
- always forwards inference to the exact ChatGPT Codex URL;
- forwards only an explicit request/response header allowlist;
- streams request and response bodies and propagates cancellation;
- never stores credentials or logs request bodies or authorization headers.

Before rebinding the live relay, a remote-development Worker requested
`http://codex-egress.internal/health` through the VPC Service. The exact response was `200 ok`,
proving the private Worker-to-host path without sending credentials.

After adding the binding to the existing relay Worker—without changing its name, Durable Object
namespace, or stored credential—the authenticated GPT-5.6 Sol canary returned exactly:

```text
LIVE-SIDECAR-OK
```

The implementation landed in commit `2ef0055` (`feat: route Codex inference through private VPC
egress`).

## Why This Works

The failure was caused by the request's Worker network origin, not by malformed OAuth state or a
missing browser cookie. Tunnel/VPC routing changes the final egress hop to a trusted ordinary host,
which reaches the upstream application normally.

The design preserves the original security boundary:

1. AgentOS never receives the OpenAI OAuth token.
2. The Durable Object remains the only refresh-token owner.
3. The request policy validates and normalizes model, body size, media, tools, and streaming before
   credentials are attached.
4. The VPC Service fixes the tunnel, host, and port; the adapter and host each independently fix the
   only allowed URL path.
5. The egress host is a stateless byte-stream transport, so moving it to another trusted host does
   not migrate credential state.

## Validation Evidence

- Relay Node suite: 140 tests passed with 100% enforced security-policy coverage.
- Relay Workerd suite: 52 tests passed with 100% enforced Durable Object/vault coverage.
- Egress-host suite: 4 tests passed for health, fixed routing, header isolation, streaming, and
  generic failure behavior.
- Relay Wrangler dry run exposed only the intended VPC Service binding.
- Named Tunnel reached healthy state with four QUIC connections.
- Credential-free VPC health probe returned exact `200 ok`.
- Live AgentOS inference rendered exact `LIVE-SIDECAR-OK`.
- No disconnect, credential copy, credential read, or token logging was performed.

## Prevention

- Probe the upstream path from the intended production network before treating an HTTP challenge as
  an OAuth bug.
- Use a credential-free request first and compare the response shape across Worker, AI Gateway, and
  ordinary-host egress.
- Never duplicate one rotating refresh token across Durable Objects, environments, or brokers.
- Keep OAuth ownership separate from inference transport so egress can change without credential
  migration.
- Require a credential-free private `/health` probe before binding a live credentialed relay.
- Keep the egress host fixed-destination, loopback-only, non-logging, and private to the VPC Service.
- Run `cloudflared` and the egress host under a process supervisor on an always-on trusted host before
  treating this spike topology as production infrastructure.
- Preserve direct Worker egress as the default when `CODEX_EGRESS` is absent so deployments that do
  not encounter this upstream policy need no extra infrastructure.

## Related Issues

No related issues documented yet.
