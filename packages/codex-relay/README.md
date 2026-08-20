# Codex subscription relay

Private Cloudflare Worker sidecar that owns one Codex OAuth credential and exposes it only to the
Workshop backend over a typed Service Binding. Its default HTTP entrypoint always returns 404.

This integration is experimental and for private deployments. It borrows the OAuth client identity
used by the pinned Pi/OMP implementation and must not be distributed publicly or commercially
without authorization from OpenAI or a separately authorized client identity.

## Deployment boundary

The config is deliberately named `wrangler.private.jsonc`. Cloudflare OS's hosted release renderer
does not yet understand required private sidecars, their deploy-before-backend order, or secret
provisioning. The ordinary release discovery scans only `wrangler.jsonc`, so it cannot accidentally
publish a manifest that the current renderer deploys incorrectly.

Deploy this Worker before the Workshop backend, provision its wrapping key as a Wrangler secret,
and add only this backend Service Binding:

```json
{
  "binding": "CODEX_RELAY",
  "service": "codex-relay",
  "entrypoint": "CodexRelay"
}
```

Never bind the relay to the router. Enable model projection only after the binding exists by setting
`CODEX_SUBSCRIPTION_ENABLED=true` on the backend. Disable that flag first during rollback. Use the
admin disconnect operation before deleting a Worker or Durable Object namespace.

For local development, put `CODEX_WRAPPING_KEY_CURRENT` in the gitignored
`packages/codex-relay/.dev.vars`, then start the normal dev server with
`CODEX_SUBSCRIPTION_ENABLED=true`. The dev script starts and binds the relay only in that explicit
mode; it never binds the router. Do not reuse a production refresh token in local development.
