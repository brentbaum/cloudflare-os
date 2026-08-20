# Codex Subscription Sidecar Runbook

This integration is private and experimental while it uses the OAuth client identity borrowed from
the pinned Pi/OMP implementation. Do not publish or sell it without OpenAI authorization or a
separately authorized client identity.

## Safety invariants

- One real subscription has exactly one canonical `CodexAuth` credential owner.
- Never copy a refresh token into preview, staging, another Durable Object, a local fixture, or an
  AgentOS model configuration. Refresh-token rotation can strand duplicated owners.
- Preview uses only `codex-fake-upstream` and a preview-only wrapping key.
- The relay has `workers_dev=false`, `preview_urls=false`, no router binding, and a default HTTP 404.
- The backend projects Codex only when both the `CODEX_RELAY` binding exists and
  `CODEX_SUBSCRIPTION_ENABLED=true`.
- OAuth tokens, account IDs, request bodies, and credential envelopes never enter logs or this file.

## Private/manual deployment

The hosted deploy renderer does not yet support required private sidecars. The relay therefore uses
`wrangler.private.jsonc`, which keeps it out of the current release manifest.

1. Deploy `packages/codex-relay` first with its private config and Durable Object migration.
2. Set `CODEX_WRAPPING_KEY_CURRENT` interactively with `wrangler secret put`; use 32 random bytes
   encoded as canonical base64. Do not place the value in shell history, a command argument, config,
   CI logs, or source control.
3. Add only this Service Binding to the Workshop backend deployment:

   ```json
   {
     "binding": "CODEX_RELAY",
     "service": "codex-relay",
     "entrypoint": "CodexRelay"
   }
   ```

4. Deploy the backend with `CODEX_SUBSCRIPTION_ENABLED=false` and verify that no Codex models are
   projected.
5. Confirm the relay has no public workers.dev or preview URL and that the router has no relay
   binding.
6. Set `CODEX_SUBSCRIPTION_ENABLED=true`, deploy the backend, and use the existing admin capability
   to start the one canonical device login.

For key rotation, set the old value as `CODEX_WRAPPING_KEY_PREVIOUS`, install the new current key,
deploy, and exercise one credential read/write before removing the previous secret. Never generate
both keys inside the Durable Object whose contents they protect.

## Fake preview

The preview topology is:

```text
codex-fake-upstream -> codex-relay -> workshop-backend -> router
```

`PREVIEW_CODEX_WRAPPING_KEY` is a preview-only canonical base64 32-byte value supplied through GitHub
Actions secrets. The preview tool uploads it as `CODEX_WRAPPING_KEY_CURRENT`; it is never written to
the generated Wrangler config. Generate preview configs and inspect the dry-run before any deploy.

Required preview checks:

- relay and fake upstream report no public URL;
- backend alone has `CODEX_RELAY -> codex-relay/CodexRelay`;
- relay alone has `CODEX_UPSTREAM -> codex-fake-upstream`;
- every Service Binding carries the sibling preview ID, never the baseline Worker;
- login, refresh, streaming, cancellation, disconnect, and error fixtures contain only obvious fake
  authority;
- preview deletion removes all four deployment tiers in dependent-first order.

## Controlled live canary

The live canary requires a deployment administrator and intentionally pauses for device approval.
Record only pass/fail, timestamps, status codes/classes, latency, and request IDs known not to encode
authority.

1. Verify feature flag off, binding health, private reachability, log redaction, and one credential
   owner.
2. Enable the flag and complete one device login into the production `shared-v1` owner.
3. Send one small text prompt through GPT-5.6 Sol and confirm incremental SSE delivery.
4. Send one small image prompt; confirm PDFs remain rejected locally.
5. Exercise one tool-call continuation and confirm the same stream semantics.
6. Exercise concurrent near-expiry requests in a controlled window and confirm exactly one refresh.
7. Confirm no AI Gateway route, bearer header from AgentOS, or monetary API-cost estimate was used.
8. Disconnect through the admin UI. Confirm projected models and stale quick/preferred selections are
   unavailable and an old chat gets the explicit reconnect-required error.
9. Scan captured logs and artifacts for token/JWT/authorization/account/header/body patterns. A match
   blocks release.

Do not run the real canary in preview or staging. If a separate test subscription is unavailable,
all non-production validation remains on the fake upstream and the real canary uses the canonical
production relay only.

## Rollback

1. Set `CODEX_SUBSCRIPTION_ENABLED=false` and deploy the backend. Existing API-key providers remain
   available.
2. If compromise or ambiguous refresh is suspected, invoke admin disconnect and record only the
   sanitized resulting state.
3. Roll back AgentOS independently. Leaving a disconnected sidecar deployed is safer than deleting
   its namespace prematurely.
4. Delete a relay Worker or Durable Object namespace only after disconnect and secret-removal
   evidence exists. Namespace deletion is destructive and is not routine rollback.

Reconnect is always a fresh device login. Never repair a failed or ambiguous rotation by copying an
old refresh token or restoring ciphertext from another environment.
