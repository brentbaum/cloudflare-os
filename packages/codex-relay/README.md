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

## Wrapping-key rotation

`CODEX_WRAPPING_KEY_CURRENT` must be a base64-encoded 32-byte AES key. To rotate it without making
existing encrypted Durable Object state unreadable:

1. Move the old current value to `CODEX_WRAPPING_KEY_PREVIOUS`, set a newly generated value as
   `CODEX_WRAPPING_KEY_CURRENT`, and deploy both secrets together.
2. Reconnect each active Codex connection (or allow its credential to refresh) so its state is
   encrypted with the new current key. The previous key is decrypt-only; new state never uses it.
3. Remove `CODEX_WRAPPING_KEY_PREVIOUS` only after no live state still depends on it. Removing it
   early intentionally fails closed and requires affected users to reconnect.

Run `pnpm --filter @gadgets/codex-relay types:check` in CI to ensure the type artifact generated
from `wrangler.private.jsonc` has not drifted.
