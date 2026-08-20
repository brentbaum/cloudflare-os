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
| 1A. OAuth, vault, refresh | in progress | Pure and Workerd tests cover every state and fail-closed refresh outcome. |
| 1B. Pi transport seam | maker complete, checking | Existing bearer behavior passes; external auth streams over an injected fetch. |
| 1C. AgentOS provider and UI | in progress | Namespaced models, admin connection UX, and API-key regressions pass. |
| 1D. Worker, preview, release harness | in progress | Private binding, migration, fake upstream, and private/manual deployment tests pass. |
| 2. Cross-lane integration | pending | Full fake-upstream login through disconnect passes with streaming and cancellation. |
| 3. Preview and live canary | pending | Public negative probe, canonical live flow, disconnect, and secret scans pass. |

## Current Slice

Wave 1: implement the relay vault, Pi external-auth patch, AgentOS integration, and deploy/test harness in isolated worktrees. Pi 0.83 already supplies injected `fetch`; do not patch that seam.

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
- Wave 1B maker commit `4162788` patches only Pi's external authorization seam; independent checking is in progress.

## Open Questions

- None. Stop the loop only if dependency drift contradicts a locked decision or live validation needs user interaction.

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

## Test and Probe Ledger

| Command/probe | Result | Notes |
|---|---|---|
| `git rev-parse HEAD` | pass | Baseline is `dd2b015071fe21de49fe2a68b57ef966dde15877`. |
| `pnpm install --frozen-lockfile` | pass | 679 packages; 874 lock entries passed supply-chain policy. |
| `pnpm build` | pass | 67 uncached build tasks completed. |
| `pnpm test` | pass | Root and all package tests completed; existing warning output only. |
| Pi 0.83 injected-fetch probe | pass | `StreamOptions.fetch` exists and Codex SSE uses it; no fetch patch required. |
| Pi 0.83 model catalog probe | pass | `gpt-5.6-sol` and `gpt-5.6-luna` are present. |
| `pnpm --filter @gadgets/workshop-shared build` | pass | Frozen relay RPC contract typechecks. |
| `node --test scripts/preview/staging-config.test.ts scripts/env-passthrough.test.ts` | pass | 30 tests; private relay/fake topology, safe vars, and preview key handling. |
| `node --test scripts/release/manifest-lib.test.ts` | pass | 5 tests; current hosted manifest remains stable and explicitly excludes private relay. |
| preview `config` + `deploy --dry-run` with fake values | pass | 20 private/public Worker configs; four-tier order and no private hostnames. |
| `pnpm lint` | pass | Existing warnings only; includes scripts typecheck and full workspace build. |

## Secret-Safety Ledger

- No real OAuth login has been started.
- No credential file has been read or copied.
- Fixtures must use unmistakably fake values and pass a token-pattern scan.

## Token/Cost Log

- Monetary API cost is not reported for subscription inference.
- No live inference has run.

## Next Action

Dispatch Wave 1 lanes from the frozen contract commit, integrate in dependency order, and have a different checker validate each lane.
