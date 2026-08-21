# Codex egress host

Loopback-only inference proxy for deployments where `chatgpt.com` challenges Cloudflare Worker
egress. It accepts one fixed Codex Responses route from a Cloudflare VPC Service, forwards it to
one fixed upstream URL, and streams the response back without storing credentials or logging
requests.

Run it on the host connected to the named Cloudflare Tunnel:

```sh
CODEX_EGRESS_PORT=8790 pnpm --filter @gadgets/codex-egress-host start
```

The server binds only to `127.0.0.1`. Configure the VPC Service with type `http`, hostname
`localhost`, and the same port. It exposes `GET /health` for a credential-free private-path probe;
all other traffic must be `POST /backend-api/codex/responses`. The host is an inference transport
only—the relay Durable Object remains the sole OAuth credential and refresh-token owner.

For a durable deployment, run this package and `cloudflared` under the host's process supervisor.
Do not enable request/debug logging or expose the port on a public interface.
