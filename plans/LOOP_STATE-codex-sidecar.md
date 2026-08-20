# Codex Subscription Sidecar Loop State

## Context

- Goal: implement the reviewed Codex subscription sidecar end to end in `brentbaum/cloudflare-os`.
- Integration branch: `feat-codex-subscription-sidecar`.
- Canonical plan: `plans/codex-subscription-sidecar.md`.
- Upstream baseline: `cloudflare/cloudflare-os@dd2b015071fe21de49fe2a68b57ef966dde15877`.
- V1 tenancy: one shared subscription credential for all authenticated users; admin-only connection management.
- V2 direction: one connection per user, with fresh login rather than refresh-token copying.

## Pinned Upstream and Dependency Versions

- Cloudflare OS: `dd2b015071fe21de49fe2a68b57ef966dde15877`.
- `@earendil-works/pi-ai`: `0.83.0`, upstream tag `v0.83.0`, commit `845d6ff`.
- OMP auth reference: `@oh-my-pi/pi-ai@17.3.4`; port only the portable contract.

## Plan

| Wave | Status | Exit gate |
|---|---|---|
| 0. Contract spine and dependency probes | complete | Shared relay types compile; Pi probe identifies only the external-auth gap; deployment boundary is explicit. |
| 1A. OAuth, vault, refresh | complete | 137 Node and 52 Workerd relay tests cover classification, encryption, rotation, crash markers, races, backoff, and fail-closed outcomes. |
| 1B. Pi transport seam | complete | Legacy bearer behavior and external auth over injected SSE pass against the pinned package patch. |
| 1C. AgentOS provider and UI | complete | Shared model projection, gateway/billing bypass, unknown cost, historical chat behavior, and admin lifecycle tests pass. |
| 1D. Worker, preview, release harness | complete locally | Private binding, migration, fake upstream, generated types, and private/manual deployment dry-runs pass. |
| 2. Cross-lane integration | complete | Real backend auth, text/image/tool workspace inference, login, refresh, cancellation, premature close, disconnect, billing bypass, and stale-history behavior pass through Workerd. |
| 3. Preview and live canary | waiting for user interaction | Cloudflare preview credentials and one canonical OpenAI device approval are required. |

## Current Slice

Wave 3: deploy the fake-only preview, run the public negative probe and teardown, then perform one canonical production device login and canary. Local implementation and validation are complete; `wrangler whoami` reports expired authentication.

## Done With Evidence

- Goal recorded in the Codex task with no token budget cap.
- Fork created: `https://github.com/brentbaum/cloudflare-os`.
- Integration worktree created from the pinned upstream commit.
- Upstream push disabled locally to prevent accidental writes to `cloudflare/cloudflare-os`.
- Engineering plan copied into the fork.
- `pnpm install --frozen-lockfile` passed, including the repository supply-chain policy check.
- Baseline `pnpm build` passed.
- Baseline `pnpm test` passed: root scripts, package suites, and Workshop Workerd integration.
- Pi 0.83 contract probe confirmed `StreamOptions.fetch` and SSE dispatch through `options.fetch`; only external authorization remains missing.
- Pi 0.83's Codex catalog contains both locked v1 models: `gpt-5.6-sol` and `gpt-5.6-luna`, each with catalog-owned metadata.
- Added and compiled the shared `CodexRelayContract`, including sanitized status/device-poll types and the raw Request/Response inference capability.
- Deployment probe proved that classifying the relay as a gatekeeper would expose it through router wiring. The relay has its own private role.
- Added the explicit private Worker package/deployment boundary, fake-preview topology, local opt-in wiring, and controlled-canary/rollback runbook.
- Pi 0.83 is patched only for explicit external authorization. The version-keyed pnpm patch contains truthful generated JS/maps/declarations from the exact upstream source and preserves legacy bearer behavior.
- The relay owns device OAuth, AES-GCM encrypted credentials, current/previous wrapping keys, exact refresh/exchange operation markers, single-flight rotation, bounded zstd decoding, an explicit Pi request schema, header reconstruction, one safe 401 retry, raw response streaming, and local disconnect.
- Every relay post-await write proves ownership of the exact epoch, generation, encrypted envelope, and operation marker. Deterministic Workerd races cover disconnect/new-login against refresh, restore, encryption, commit, and decrypt failures.
- The outer relay copies and disposes management RPC results; streamed inner response capabilities dispose once on EOF, error, or cancellation. The Workerd suite has clean output.
- AgentOS projects Sol and Luna only behind the feature flag plus binding, routes them before AI Gateway/BYOK billing, treats subscription cost as unknown, invalidates stale epoch-backed selections, and preserves historical Codex IDs so disconnected chats fail with a reconnect error.
- The admin capability controls connect/poll/reconnect/disconnect. Non-admins can use ready shared models but cannot mint the capability, add/delete the shared profiles, or observe device credentials.
- The real cross-package Workerd gate exercises authenticated backend RPC, admin-only device login, both users' model projection, Pi zstd/SSE, two concurrent expired streams with one refresh, bounded upstream cancellation, an exhausted Cloudflare quota, unknown persisted cost, disconnect, and historical-chat failure without fallback.
- The same gate now covers an authenticated PNG, real multi-turn function-call continuation, and premature SSE closure through User, Overseer, and the agent runtime.
- Refresh `429` state stores a generation-scoped 1-second-to-5-minute cooldown and surfaces sanitized `Retry-After`; repeated and concurrent requests cannot create a token-endpoint retry storm.
- Owned terminal login failures return a sanitized reconnect-required result; true stale attempts alone return superseded. The admin UI resumes transient polling and maps stable reasons to actionable copy.
- Enforced coverage is 100% for all critical modules: Node OAuth/policy/security decisions and the exact validated Workerd vault/security code. No reachable branch is ignored; the sole coverage exclusion is the conforming-zlib defensive non-`Error` throw arm.
- Local performance proxies run 100 warmed first-byte samples at p95 <=250 ms, abort-to-upstream cancellation under 500 ms, and real 1 MB/50 MB raw transfers without full-body materialization. Actual Worker queue depth/RSS and regional measurements remain preview gates.
- The fork preview workflow explicitly trusts only `cloudflare` and `brentbaum` repository owners while retaining same-repo PR, maintainer association, non-bot, safe-trigger, and live write-permission checks.
- The preview generator creates 20 configs in four tiers: fake upstream, private relay, backend, and public router. Only the backend binds the relay; the router never does. Hosted one-click release intentionally excludes the private role until the external renderer learns it.

## Open Questions / External Gates

- Renew Wrangler authentication (or provide `CLOUDFLARE_API_TOKEN`) so the fake-only preview can be deployed, probed, and deleted.
- After preview passes, a deployment administrator must approve one OpenAI device login into the canonical production `shared-v1` owner for the controlled canary.
- Do not create a second real credential owner for staging or preview; rotating refresh tokens make duplicated owners unsafe.

## Decisions

- One Worker project contains the WorkerEntrypoint and one Durable Object class per credential connection.
- Browser callers never choose a connection key; AgentOS derives it after authentication.
- Tokens stay inside the sidecar object and its upstream request memory.
- Request-time refresh only in v1; no alarms.
- Preview uses fake upstream and fake credentials. Production is the only canonical real credential owner.
- The borrowed Pi/OMP OAuth identity makes the feature private and experimental.
- The pinned Pi package is patched only for explicit external authorization; existing fetch and SSE support remain upstream-owned.
- Hosted one-click deployment is not claimed in this fork until the external deploy renderer understands a required private sidecar. The fork supplies private/manual deployment and preview wiring instead.
- The backend projects Codex only when both `CODEX_SUBSCRIPTION_ENABLED=true` and `CODEX_RELAY` are present.

## Failed Attempts and Why

- `worktree-manager.sh create <lane> feat-codex-subscription-sidecar` failed because the manager
  tries to check out/update the base branch and Git refuses while that branch is active in the
  integration worktree. Created an unoccupied `codex-wave0` snapshot at `36a0677` and based all
  lane worktrees on that exact commit instead.
- The first fake preview dry-run invocation passed an extra literal `--`; the CLI rejected it before any network action. Re-running `pnpm preview:deploy --dry-run` succeeded.
- Catching the cross-RPC cancellation at Pi's exact `reader.read()` boundary did not change Vitest-pool's independent pending-RPC diagnostic. No ineffective Pi change shipped. The dedicated one-test config suppresses only the exact canonical message when its source-mapped stack is Pi 0.83's `parseSSE`; production has no suppression, and the test separately asserts bounded abort, an un-aborted post-header request signal, and exactly one upstream cancellation.

## Test and Probe Ledger

| Command/probe | Result | Notes |
|---|---|---|
| `git rev-parse HEAD` | pass | Implementation HEAD before ledger update: `b8ba8d4aec156c3acd5e365d17143bab5d38778d`; baseline is `dd2b015071fe21de49fe2a68b57ef966dde15877`. |
| `pnpm install --frozen-lockfile --offline` | pass | All 28 workspace projects are up to date; the pinned Pi patch resolves reproducibly. |
| `pnpm test` | pass | 148 root script tests plus every workspace package suite; backend reports 349 unit, 2 Workerd integration pass/4 existing skips, and the dedicated sidecar lifecycle pass. |
| `pnpm lint` | pass | Existing unrelated warnings only; new code has no lint errors. |
| `pnpm build` | pass | Full recursive workspace build completes, including relay, backend Worker, frontend, and shared types. |
| Pi 0.83 injected-fetch probe | pass | `StreamOptions.fetch` exists and Codex SSE uses it; no fetch patch required. |
| Pi 0.83 model catalog probe | pass | `gpt-5.6-sol` and `gpt-5.6-luna` are present. |
| `pnpm --filter @gadgets/workshop-shared build` | pass | Frozen relay RPC contract typechecks. |
| `pnpm --filter @gadgets/codex-relay test:run` | pass | 137 Node + 52 Workerd tests; clean RPC lifecycle output. |
| relay enforced coverage | pass | Node: 401/401 statements, 330/330 branches, 53/53 functions, 352/352 lines. Workerd: 301/301 statements, 148/148 branches, 38/38 functions, 272/272 lines. |
| `pnpm --filter @gadgets/codex-relay types:check` | pass | Private Wrangler type artifact matches regenerated output after whitespace normalization. |
| `pnpm --filter @gadgets/workshop-backend test:sidecar` | pass | One serial Workerd lifecycle covers auth through historical disconnect behavior, including real workspace inference and exhausted billing quota. |
| `pnpm --filter @gadgets/workshop-frontend test:run` | pass | 193 tests; existing jsdom scroll warning only. |
| `node --test scripts/preview/staging-config.test.ts scripts/env-passthrough.test.ts` | pass | Private relay/fake topology, safe vars, signal flags, and preview key handling. |
| `node --test scripts/release/manifest-lib.test.ts` | pass | 5 tests; current hosted manifest remains stable and explicitly excludes private relay. |
| preview `config`, `deploy --dry-run`, and `delete --dry-run` with fake values | pass | 20 configs; four-tier deployment, only router public, dependent-first teardown. |
| local performance proxy | pass | 100 warmed first-byte samples p95 <=250 ms; abort-to-cancel <500 ms; 1 MB/50 MB raw transfer and no full materialization. |
| relay `wrangler deploy -c wrangler.private.jsonc --dry-run` | pass | Private Worker bundle, Durable Object migration, and RPC exports build successfully. |
| `wrangler whoami` | blocked externally | Stored Cloudflare authentication is expired and non-interactive refresh failed; no deployment was attempted. |
| changed-file secret-pattern scan | pass | Matches occur only in obvious fake upstream/test fixtures; no real credential source was read. |
| `git diff --check dd2b015` | pass | No whitespace or conflict-marker errors. |

## Secret-Safety Ledger

- No real OAuth login has been started.
- No credential file has been read or copied.
- Repository scans find token-shaped values only in unmistakably fake fixtures.
- Preview config/dry-run used a fake account ID, `.invalid` admin, fake Access identifiers, and the documented fake 32-byte wrapping key.

## Token/Cost Log

- Monetary API cost is not reported for subscription inference.
- No live inference has run.

## Next Action

1. Complete the mandatory post-completion critic pass and address any Critical/Important finding.
2. Push the clean implementation branch to `brentbaum/cloudflare-os`.
3. Renew Cloudflare authentication, deploy the fake-only preview, verify private negative reachability and end-to-end fake login/stream/cancel/disconnect, then delete it.
4. With explicit administrator participation, deploy disabled first, enable the feature, perform one canonical device login, run the production canary, disconnect, and complete the final secret/log scan.
