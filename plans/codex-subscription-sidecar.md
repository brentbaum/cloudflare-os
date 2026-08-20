# AgentOS Codex Subscription Sidecar: Implementation Plan

Status: engineering-reviewed and ready to execute in a fork
Target: `cloudflare/cloudflare-os` fork, pinned initially to `dd2b015071fe21de49fe2a68b57ef966dde15877`
Upstream issue: [cloudflare/cloudflare-os#89](https://github.com/cloudflare/cloudflare-os/issues/89)
Review date: 2026-08-20

## Outcome

Add a first-class **ChatGPT Plus/Pro (Codex)** provider to a private AgentOS deployment. In v1, one subscription credential is shared by every authenticated AgentOS user. Only configured administrators may connect, reconnect, or disconnect it. A later milestone changes credential selection to one connection per user without changing the Codex transport or sidecar protocol.

The implementation is an independently deployed, private Cloudflare Worker package inside the fork. It owns one Durable Object per OAuth connection and is reachable from AgentOS only through a Service Binding. OAuth tokens never enter model configuration, the browser, an Overseer, resumable agent state, or logs.

This is private and experimental while it borrows the OAuth client identity used by Pi/OMP. It is not approved for public or commercial distribution until OpenAI confirms that usage or a separately authorized client identity exists.

## Locked Decisions

1. **V1 tenancy:** one shared subscription credential serves all authenticated AgentOS users.
2. **V2 tenancy:** migrate to one credential connection per AgentOS user.
3. **Experience:** full provider UI, device-code login, connection state, model projection, streaming, and disconnect behavior.
4. **Transport:** add a small upstreamable Pi seam for injected `fetch` and relay-managed authorization; keep Pi's Codex payload and SSE parser.
5. **Packaging:** add `packages/codex-relay` inside the fork as one private Worker project containing its Worker entrypoint and Durable Object.
6. **OAuth reuse:** port only the Workerd-safe device and refresh primitives from pinned Pi/OMP source. Do not run or import the Bun/SQLite OMP broker.
7. **Credential topology:** one canonical Durable Object owns each rotating refresh token. Never copy one credential into preview, staging, and production.
8. **Initial transport:** SSE only. No WebSocket fallback.
9. **Cost display:** subscription cost is `unknown`, never `$0` and never Pi's API price estimate.

## Scope Challenge Result

The plan crosses the review's complexity threshold: approximately 12-18 files and two runtime classes (`CodexRelay` and `CodexAuth`). The user chose the complete provider integration rather than a headless shortcut.

The moving parts are justified:

- AgentOS already separates provider UI, shared RPC contracts, backend model resolution, and deployable Workers. Each layer needs a small additive change.
- A private Worker plus one Durable Object is the minimum safe sidecar. Splitting routing and credential storage into separate deployables would add failure modes without improving isolation.
- Current Pi transport needs one narrow seam because changing only `baseUrl` cannot route global `fetch()` through a Cloudflare Service Binding.
- The plan does not introduce a generic OAuth broker, generic credential vault, alarm scheduler, WebSocket proxy, or new agent runtime.

## What Already Exists

| Existing capability | Location at pinned upstream | Reuse decision |
|---|---|---|
| Authenticated user RPC and model management | `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/user.ts` | Extend with non-secret Codex connection operations and projected models. Do not create a second browser API stack. |
| Model resolver and Pi stream handles | `packages/workshop-backend/src/ai-models.ts` | Add a distinct `openai-codex` direct path that bypasses both AI Gateway routes. |
| Pi Codex catalog, request builder, tool continuation, and SSE parser | `@earendil-works/pi-ai` | Reuse. Patch only the fetch/auth boundary. |
| Cloudflare service-bound Worker pattern | existing `packages/gatekeeper-*`, preview scripts, release manifest tooling | Follow its build, binding, preview, and no-public-route conventions. Do not force Codex into the generic Gatekeeper abstraction. |
| Worker-native Vitest setup | root and `workshop-backend` Vitest configurations | Use Node Vitest for pure functions and `@cloudflare/vitest-pool-workers` for DO/RPC/stream tests. |
| Device-code and rotating-refresh semantics | pinned Pi/OMP source and official Codex source | Port narrow pure functions with attribution, injected `fetch`, injected clock, and drift fixtures. |
| Local Codex OAuth fixture patterns | Soulsoft `apps/reto/tests/eval-codex-auth.test.ts` | Reuse fake JWT and secret-redaction test ideas only. Never copy the filesystem credential importer into runtime code. |

Issue #89 was closed after its author moved the specification to a separate fork. This plan deliberately changes its credential boundary: tokens remain in the sidecar Durable Object rather than traveling transiently to the Overseer.

## Architecture

```text
Browser
  | existing authenticated AgentOS RPC
  | status/startLogin/pollLogin/disconnect contain no OAuth token
  v
AgentOS backend Worker
  | validates administrator for connection management
  | allows every authenticated user to select projected Codex models
  | derives connection key; browser never supplies it directly
  | typed Service Binding RPC
  v
packages/codex-relay                  one Wrangler project, no public route
  | CodexRelay WorkerEntrypoint
  |   status(key)
  |   startLogin(key)
  |   pollLogin(key, attemptId)
  |   disconnect(key)
  |   infer(key, Request)
  v
CodexAuth Durable Object             one object per OAuth connection
  | encrypted pending login state
  | encrypted credential generation
  | request-time refresh coordination
  | fixed-origin Codex request policy
  | streaming upstream fetch
  v
OpenAI device/token endpoints + ChatGPT Codex Responses backend
```

The Worker entrypoint's `fetch()` always returns 404. Wrangler sets `workers_dev: false` and `preview_urls: false`. Only explicitly exported RPC methods exist as capabilities.

### V1 to V2 credential routing

```text
V1 shared mode
  authenticated user -> backend derives connection key "shared-v1"
                     -> one CodexAuth object

V2 per-user mode
  authenticated user -> backend derives opaque stable key from user identity
                     -> one CodexAuth object for that user

Never accepted:
  browser-provided connection key -> sidecar
```

Do not build V2 UI or migration in the v1 branch. Do make `connectionKey` an internal backend-to-sidecar argument so V2 changes key derivation rather than transport internals. The sidecar must not know AgentOS user records.

### Trust and authorization rules

- Every authenticated user may use the shared projected models in v1.
- Only users matching AgentOS's existing administrator policy may start, poll, reconnect, or disconnect the shared credential.
- Non-admin users receive only model availability and sanitized inference errors. They never receive login codes or detailed credential state.
- AgentOS derives the connection key after authentication. It rejects any browser field that attempts to choose a connection.
- The sidecar accepts only a Service Binding. It has no public inference or admin endpoint.
- `infer` accepts one fixed request capability, not a caller-selected URL.
- The sidecar overwrites `Authorization`, ChatGPT account, originator, content type, and required beta headers. It rejects or strips caller-supplied security-sensitive headers.
- The sidecar hardcodes the ChatGPT backend origin and `/backend-api/codex/responses` path, allowed methods, allowed models, accepted media, and body-size ceiling.
- Response headers are allowlisted. `Set-Cookie` and unrelated upstream metadata are removed.

### Provider and model representation

Change `AiModelConfig` from one API-token-shaped object to a discriminated union:

```ts
type ApiKeyModelConfig = {
  provider: "openai" | "anthropic" | "google" | "cloudflare" | "ollama";
  model: string;
  apiToken: string;
  accountId?: string;
  apiUrl?: string;
};

type CodexModelConfig = {
  provider: "openai-codex";
  model: string;
  connection: "shared-v1"; // internal projection, not a secret or browser choice
};
```

Do not encode Codex as `openai` with an empty or synthetic API key. Namespaced selectable IDs such as `openai-codex/gpt-5.6-sol` coexist with API-key OpenAI models. The upstream model ID remains the catalog model ID.

Project GPT-5.6 Sol as the primary interactive option and GPT-5.6 Luna as the quick option, taking names, capabilities, context windows, and output limits from Pi's Codex catalog. If either exact ID is absent from the pinned catalog at implementation time, stop the loop and record a contract-drift decision instead of inventing metadata.

### Pi transport seam

Current Pi Codex transport constructs bearer/account headers and invokes global `fetch`. A private Cloudflare Service Binding therefore needs a small upstreamable extension:

```ts
type CodexTransportOptions = {
  transport?: "sse" | "websocket" | "auto";
  fetch?: typeof globalThis.fetch;
  authorization?:
    | { mode: "bearer"; apiKey: string }
    | { mode: "external" };
};
```

Required behavior:

- Existing callers and bearer mode remain byte-for-byte compatible.
- External mode does not require or decode a JWT and does not construct authorization/account headers.
- Injected `fetch` receives Pi's already-built fixed Codex request.
- AgentOS injects a wrapper that ignores the target network URL and calls `env.CODEX_RELAY.infer(connectionKey, request)`.
- Force `transport: "sse"` in AgentOS. Do not permit Pi's WebSocket-first `auto` mode.
- Keep Pi's request construction, SSE event parser, reasoning behavior, usage parsing, and tool-call continuation.
- Carry the change as a pinned package patch with a source test. Open an upstream Pi PR, but do not block the fork on its acceptance.

## OAuth and Credential State

Port only these operations from the pinned Pi/OMP implementation:

- start device authorization;
- poll the device token endpoint once;
- exchange the authorization result;
- refresh a credential;
- validate response shapes;
- extract the ChatGPT account claim from the access-token JWT;
- classify pending, expired, denied, transient, invalid, and ambiguous outcomes;
- redact secrets.

Do not import OMP's callback server, Bun timers, filesystem importer, SQLite broker, or background process.

```text
DISCONNECTED
  | administrator starts login
  v
PENDING {attemptId, encrypted device state, interval, nextPollAt, expiresAt}
  | pending/429        -> remain PENDING with enforced backoff
  | denied/expired     -> erase pending secret -> DISCONNECTED
  | authorized         -> validate + atomically store credential -> READY
  | newer attempt      -> invalidate older attempt
  v
READY {encrypted credential, generation, expiresAt}
  | request outside refresh margin -> infer
  | request inside refresh margin  -> REFRESHING (in memory + durable marker)
  v
REFRESHING
  | validated success -> atomically store full rotation, clear marker -> READY
  | definitive transient before ambiguous point -> retain prior state, retry later
  | invalid_grant -> erase unusable authority -> REAUTH_REQUIRED
  | timeout/reset after refresh request may have been consumed -> REAUTH_REQUIRED
  | storage failure after successful rotation -> CREDENTIAL_STATE_UNKNOWN

DISCONNECT from any state:
  erase credential, account ID, pending attempt, marker, and derived availability
```

`REFRESHING` uses an in-memory `refreshPromise` so concurrent requests in one live object join one exchange. Before network I/O, persist `{generation, attemptId, startedAt}`. Never hold `blockConcurrencyWhile()` across the token endpoint call. If the object restarts with the marker present, the refresh outcome is unknowable because rotation may have succeeded upstream. Fail closed and require login rather than retrying the old refresh token.

Skip proactive refresh alarms in v1. Refresh at request time with a five-minute margin. An alarm would duplicate logic and does not remove the need for request-time refresh.

### Storage envelope

Cloudflare encrypts Durable Object storage at rest. Add a small application envelope to reduce accidental disclosure in inspection and exports:

```text
{ version, keyId, iv, ciphertext }
AAD = objectId + credentialSchemaVersion
```

Use AES-GCM with a Worker secret. Accept the current and immediately previous wrapping key for rotation. Never log plaintext, ciphertext, OAuth bodies, device codes, user codes, authorization codes, verifiers, access tokens, refresh tokens, account IDs, or request bodies.

## Inference Behavior

1. AgentOS resolves the namespaced model and constructs Pi's Codex model descriptor from the pinned catalog.
2. AgentOS selects Pi's `openai-codex-responses` transport with external authorization, injected Service Binding fetch, and forced SSE.
3. `CodexRelay.infer()` maps the internal connection key to its `CodexAuth` Durable Object.
4. The object resolves or refreshes its credential, validates the request policy, replaces headers, and fetches the fixed ChatGPT backend.
5. The successful upstream `Response.body` passes through without buffering or SSE reserialization.
6. Cancellation propagates AgentOS -> Service Binding -> Durable Object -> upstream fetch.
7. A pre-stream 401 may trigger one refresh-and-retry only if that request did not already refresh. Never retry a partial stream, 429, or 5xx model response.
8. Preserve semantic SSE ordering and approved metadata such as content type, request ID, retry-after, and usage. Monetary cost remains unknown.

Codex must bypass both the platform AI Gateway and a user's connected AI Gateway. Existing API-key and gateway paths remain unchanged.

## User Experience

Add **ChatGPT Plus/Pro (Codex)** to the providers screen as a connection, not an API-key form.

Administrator experience:

1. Select Connect.
2. Receive a verification URL, visible user code, expiry, and poll interval.
3. Open the URL in another tab or device.
4. The browser polls AgentOS; the backend performs at most one upstream poll per allowed interval.
5. Show pending, connected, expired, denied, failed, reconnect-required, and disconnected states.
6. Allow restart and disconnect. Closing the dialog does not expose secrets; pending attempts expire within 15 minutes and are cleared on a new attempt or disconnect.

All-user experience:

- Connected Codex models appear automatically for every authenticated user.
- Codex and API-key OpenAI models can coexist.
- If disconnected, projected models disappear and quick/preferred selections pointing to them are cleared.
- Existing chats retain their historical model ID but show a clear unavailable/reconnect message when reused.
- Auth failure, shared-subscription quota/capacity, upstream quota, and transient provider failure remain distinct errors.

## Engineering Findings Folded Into This Plan

1. **[P1] (confidence 10/10) Pi 0.83 already has the private transport seam; only external authorization is missing.** The pinned package exposes injected `fetch` and forced SSE, but still requires and decodes an API-key JWT and emits bearer/account headers. Patch only that authorization boundary and lock AgentOS's injected fetch against per-call override.
2. **[P1] (confidence 9/10) Refresh rotation can become unknowable after a Worker reset.** A promise deduplicates only one live object. The durable generation marker and fail-closed ambiguous state are ship gates.
3. **[P1] (confidence 9/10) A credentialed generic proxy would expose the subscription.** Fixed origin/path/model/header policy and a binding-only deployment are ship gates.
4. **[P1] (confidence 10/10) Borrowed OAuth client identity blocks public distribution.** The feature stays private/experimental pending authorization or a dedicated client identity.
5. **[P2] (confidence 9/10) The existing `AiModelConfig` requires `apiToken`.** `packages/workshop-shared/src/api.ts:1146-1169` must become a discriminated union; placeholders would blur the security boundary.
6. **[P2] (confidence 9/10) Existing model resolution sends all providers through user/platform gateway checks first.** `packages/workshop-backend/src/ai-models.ts:350-375` needs an early distinct Codex path that can never enter AI Gateway routing.
7. **[P2] (confidence 9/10) Shared v1 lets every authenticated user spend one person's quota.** This is an explicit product decision. The provider is disabled by default, visually labeled shared, observable by non-secret counts, and easy to turn off. Connection management remains admin-only.
8. **[P2] (confidence 8/10) One shared Durable Object is a throughput and regional-hop bottleneck.** Accept for private v1, measure first-token latency and concurrency, and make per-user connections the next scaling milestone.
9. **[P2] (confidence 9/10) Model request retries can duplicate work.** Pi owns inference retry semantics; the sidecar never retries partial streams or ordinary 429/5xx responses.
10. **[P2] (confidence 9/10) `$0` subscription cost is misleading.** Preserve tokens/usage when available and represent money as unavailable.

## Test Strategy

Use four layers:

1. **Pure contract tests:** OAuth parsing, JWT claim extraction, state reduction, error classification, encryption/redaction, request policy, and AgentOS translation.
2. **Workerd integration:** real Durable Object SQLite storage, RPC Service Binding, eviction, interleaving, streaming, cancellation, and fake upstream Worker.
3. **Wrangler preview:** relay + fake OpenAI upstream + AgentOS preview, actual bindings/migrations/routes, and a negative public-route probe.
4. **Controlled live canary:** one canonical credential owner, tiny conversation, tool continuation, forced refresh observation, and disconnect. Never store test credentials or copy them to staging.

### Coverage map

```text
ADMIN LOGIN
├── unauthorized user                              [RPC integration]
├── start -> pending                               [unit + workerd]
├── malformed start                                [unit]
├── too-early poll                                 [unit + fake clock]
├── pending / 429 backoff                          [unit]
├── denied / expired / cancelled                   [unit]
├── stale attempt after restart                    [concurrency]
└── success -> encrypted READY                     [storage + eviction]

AUTHENTICATED INFERENCE
├── fresh credential                               [workerd + live]
├── near expiry
│   ├── one caller -> rotated credential           [storage]
│   ├── N callers -> exactly one refresh           [concurrency]
│   ├── definitive transient                       [unit]
│   ├── invalid_grant -> REAUTH_REQUIRED           [unit + workerd]
│   ├── reset/timeout after send -> fail closed     [eviction/fault]
│   └── persisted marker on restart -> fail closed [eviction]
├── disconnected / unavailable                     [workerd]
└── pre-stream 401 one-time refresh policy         [integration]

RELAY POLICY
├── valid service-bound request                    [multi-worker]
├── public fetch / missing binding                 [preview negative probe]
├── caller bearer/account/host/path                [security integration]
├── unsupported model/media/PDF/oversized body     [unit + integration]
└── log and response secret scan                   [all layers]

STREAM
├── semantic SSE and arbitrary chunk splits        [stream integration]
├── split UTF-8 and multi-line events               [stream integration]
├── early first byte / no full buffering            [latency assertion]
├── slow consumer / bounded memory                  [performance]
├── client cancellation -> upstream abort           [integration]
├── premature upstream close                        [integration]
├── 401 / 429 / 5xx / JSON error                    [integration]
└── concurrent streams do not cross-contaminate     [concurrency]

AGENTOS
├── connection UI states                            [frontend]
├── namespaced model projection                     [backend]
├── Sol primary / Luna quick                        [catalog contract]
├── text + image + tool continuation                [end-to-end]
├── disconnect clears models/selections             [end-to-end]
├── old chat gets clear unavailable error            [end-to-end]
├── Codex bypasses both AI Gateway routes            [regression]
└── existing API-key providers unchanged             [full regression]

DEPLOYMENT
├── release manifest includes sidecar/migration      [script test]
├── deploy order honors Service Binding target       [preview]
├── preview has fake credential namespace only       [config test]
└── production canary uses canonical owner only      [manual gate]
```

Auth transitions, refresh classification, request sanitization, and secret redaction require 100% branch coverage. Overall repository coverage does not need to become 100% as part of this feature.

### Required failure assertions

| Failure | Expected behavior | User/operator signal |
|---|---|---|
| Device approval never completes | expire and erase pending state | “Expired; start again” |
| Two login attempts overlap | newest attempt wins atomically | stale attempt cannot overwrite auth |
| Concurrent expired requests | one refresh, all waiters use persisted generation | no visible race |
| Upstream rotates token but storage write fails | fail closed | `credential_state_unknown`, operator alert |
| Object restarts with refresh marker | do not replay old refresh token | reconnect required |
| `invalid_grant` | clear unusable authority | reconnect required |
| 429/5xx before an unambiguous refresh outcome | bounded backoff where safe | recoverable provider error |
| Malicious request supplies bearer/host/path | strip or reject | stable sanitized 4xx |
| Client disconnects mid-stream | abort upstream promptly | generation stops |
| Upstream truncates SSE | never report normal success | retryable incomplete-stream error |
| Sidecar receives public URL | deployment gate fails | release blocked |
| Same refresh token configured twice | deployment/runbook check fails | release blocked |

## Performance Gates

Measure rather than optimize speculatively:

- Successful SSE handling must never call `text()`, `json()`, `arrayBuffer()`, or otherwise buffer the response body.
- Time to first byte through AgentOS and the sidecar must stay within 250 ms of the fake upstream's first byte at p95 in preview, excluding cold start. Record cold-start data separately.
- Memory must remain approximately constant as a fixture stream grows from 1 MB to 50 MB.
- Cancellation must reach the fake upstream within 500 ms in a deterministic preview test.
- Twenty concurrent near-expiry requests must perform exactly one token refresh.
- Run a private-load probe at the expected deployment concurrency. If the shared object causes unacceptable queueing or account throttling, cap/disable shared mode and advance the V2 per-user milestone. Do not add sharding around one OAuth credential.

## Implementation Loop

Create `specs/LOOP_STATE-codex-sidecar.md` in the fork. It is the spine across agents, worktrees, and context resets.

Required state sections:

```markdown
# Context
# Pinned upstream and dependency versions
# Plan
# Current slice
# Done with evidence
# Open questions
# Decisions
# Failed attempts and why
# Test and probe ledger
# Secret-safety ledger
# Token/cost log
# Next action
```

Each loop iteration follows this exact cycle:

```text
ORIENT
  read plan + LOOP_STATE + git status + latest dependency pin
  |
SELECT
  choose one smallest unfinished vertical slice with an observable exit gate
  |
PARALLEL MAKE
  dispatch only independent module lanes in isolated worktrees
  |
CHECK
  a different agent reviews each maker's diff and runs its focused gate
  |
INTEGRATE
  merge in dependency order; resolve shared files in the integration lane
  |
VERIFY
  focused tests -> package tests -> full tests at wave boundaries
  |
RECORD
  update LOOP_STATE with commands, exit codes, decisions, and next action
  |
REPEAT or STOP on an explicit gate
```

Rules:

- One maker does not certify its own work.
- Each slice starts with a failing test or contract probe and ends with a literal command plus exit code.
- No token-like value may enter a prompt, patch, fixture, screenshot, log, test output, or loop state.
- Shared files such as the lockfile, root package metadata, generated Worker types, release manifest inputs, and preview scripts have one owner: the integration lane.
- Rebase each worktree on the integration branch before handoff. Do not merge a lane with failing focused tests.
- Stop and escalate on missing model IDs, changed OAuth shapes, changed required headers, ambiguous refresh behavior, public-route exposure, or a secret-scan hit.
- Never “fix” a contract mismatch by loosening response validation or logging raw provider data.

## Parallel Worktree Plan

### Wave 0: contract spine, sequential

Pin the upstream commit and exact Pi package source. Write:

- sidecar RPC types and sanitized errors;
- credential/state schema and version;
- provider config union;
- fake upstream protocol and sanitized fixtures;
- the Pi 0.83 transport contract probe;
- `LOOP_STATE-codex-sidecar.md`.

Exit gate: shared types compile, fixtures contain unmistakably fake credentials, and the current Pi behavior probe fails only on the intended external-authorization seam. Injected fetch and forced SSE must remain covered as existing Pi behavior, not repatched.

### Wave 1: launch four independent lanes

| Lane | Work | Modules owned | Depends on |
|---|---|---|---|
| A | OAuth adapter, encryption, DO state, refresh crash semantics | `packages/codex-relay/src/auth/`, `src/storage/` | Wave 0 |
| B | Pi external-auth patch with compatibility tests | package patch/vendor mechanism, Pi contract tests | Wave 0 |
| C | AgentOS contracts, provider resolver, model projection, provider UI | `workshop-shared`, `workshop-backend`, `workshop-frontend` | Wave 0 |
| D | Workerd fixtures, fake upstream, Wrangler package, preview/release harness | `packages/codex-relay/test/`, root preview/release scripts | Wave 0 |

Conflict controls:

- Lane C alone edits AgentOS's central provider registry and frontend provider list.
- Lane D alone edits the root lockfile, workspace metadata, Worker type generation, preview scripts, and release inputs.
- Lane A exports against the frozen Wave 0 interface; it does not edit AgentOS.
- Lane B edits only the pinned Pi patch and its contract tests.

### Wave 2: staged integration

1. Merge A + D and prove login, persistence, refresh single-flight, eviction, and no-public-route behavior against the fake upstream.
2. Merge B and prove raw semantic SSE, tool continuation, backpressure, and cancellation through the Service Binding.
3. Merge C and run the full AgentOS path from authenticated UI to streamed response.
4. Run maker/checker review across the combined diff, with special review of auth boundaries and generated deployment configuration.

### Wave 3: preview and controlled live validation

1. Deploy the sidecar and its DO migration first.
2. Deploy AgentOS with `CODEX_SUBSCRIPTION_ENABLED=false`.
3. Run preview probes using only the fake upstream and isolated fake storage.
4. Enable the feature for the controlled production deployment.
5. Perform one device login into the canonical production credential owner.
6. Run text, image, tool-continuation, concurrent refresh, and disconnect canaries.
7. Scan logs and stored test artifacts for fixture and real-token patterns.
8. Record results and exact rollback commands in LOOP_STATE.

## Build-Actionable Tasks

- [ ] **T1 (P1, human: ~3h / Codex: ~30m) - Contract spine and pin**
  - Pin upstream and Pi versions; define RPC, state, provider union, errors, fixtures, and the failing Pi seam probe.
  - Verify: typecheck plus focused contract test showing only injected-fetch/external-auth gaps.
- [ ] **T2 (P1, human: ~1d / Codex: ~2h) - Pi relay transport seam**
  - Add backward-compatible external authorization only; use Pi's existing injected fetch, force SSE from AgentOS, and preserve existing Pi tests.
  - Verify: bearer-mode regression, external-mode header absence, Service Binding stream test, upstreamable patch diff.
- [ ] **T3 (P1, human: ~1.5d / Codex: ~3h) - Workerd-safe OAuth adapter**
  - Port device start, one poll, exchange, refresh, validation, JWT claim extraction, classification, and redaction from pinned Pi/OMP.
  - Verify: deterministic pure tests for every fixture and clock boundary.
- [ ] **T4 (P1, human: ~2d / Codex: ~4h) - Credential Durable Object**
  - Implement versioned encrypted storage, attempt replacement, request-time refresh, single-flight, generation marker, fail-closed restart, and disconnect.
  - Verify: Workers Vitest storage, concurrency, eviction, injected fault, and plaintext inspection tests.
- [ ] **T5 (P1, human: ~1d / Codex: ~2h) - Private inference relay**
  - Implement typed entrypoint, fixed request policy, credential/header injection, response allowlist, raw streaming, and cancellation.
  - Verify: SSRF/header attacks, body/model/media limits, SSE semantic cases, bounded memory, and public 404.
- [ ] **T6 (P2, human: ~1.5d / Codex: ~3h) - AgentOS provider integration**
  - Add `openai-codex`, bypass gateways, derive internal connection keys, project namespaced catalog models, and preserve unknown cost.
  - Verify: model resolver, coexistence, gateway bypass, quick/preferred selection, old-chat error, and API-key regressions.
- [ ] **T7 (P2, human: ~1d / Codex: ~2h) - Provider UI and admin controls**
  - Add connect/poll/restart/disconnect flows and all visible states; restrict management to admins while exposing shared model availability to authenticated users.
  - Verify: frontend state tests, non-admin authorization tests, and no-secret response scan.
- [ ] **T8 (P1, human: ~1.5d / Codex: ~3h) - Preview and release integration**
  - Add sidecar Wrangler config, DO migration, generated types, Service Binding, build tasks, preview topology, fake upstream, and private/manual deployment ordering.
  - Verify: package tests, staging-config tests, preview deploy, negative route probe, rollback dry run. Hosted one-click release remains gated on the out-of-repository deploy renderer learning the new private sidecar role; do not emit a manifest the current renderer cannot deploy.
- [ ] **T9 (P1, human: ~1d / Codex: ~2h) - Cross-package failure suite**
  - Exercise login through disconnect, tool continuation, refresh races, ambiguous faults, stream cancellation, gateway bypass, and secret scans.
  - Verify: all focused suites and root `pnpm test`, `pnpm lint`, and `pnpm build`.
- [ ] **T10 (P1, human: ~3h / Codex: ~30m) - Controlled live canary and runbook**
  - Validate one canonical account, capture only non-secret evidence, document enable/disable/reconnect/rollback, and keep public distribution blocked.
  - Verify: signed-off canary checklist and zero secret-scan matches.

## Verification Commands

Confirm package names after cloning the fork, then record exact commands in LOOP_STATE. Expected commands at the pinned revision:

```bash
pnpm install --frozen-lockfile
pnpm --filter @gadgets/codex-relay test:run
pnpm --filter @gadgets/workshop-backend test:run
pnpm --filter @gadgets/workshop-frontend test:run
pnpm test
pnpm lint
pnpm build
pnpm preview:config
pnpm preview:deploy
# run binding, SSE, cancellation, and negative-public-route probes
pnpm preview:delete
```

Every preview deployment must delete or isolate its fake Durable Object namespace. It must never reference the production credential namespace.

## Deployment and Rollback

Deployment order:

1. Ship the sidecar Worker, Durable Object migration, wrapping secrets, and observability.
2. Ship the Pi package patch.
3. Ship the AgentOS adapter and UI behind `CODEX_SUBSCRIPTION_ENABLED=false`.
4. Verify that the sidecar has no public URL and that its Service Binding resolves.
5. Enable the flag in the controlled deployment.
6. Connect the canonical credential once and run the live canary.

Rollback:

1. Disable `CODEX_SUBSCRIPTION_ENABLED`; existing providers continue working.
2. Roll back AgentOS independently while leaving the sidecar credential dormant.
3. If compromise or ambiguous refresh is suspected, use the admin disconnect path before deleting any Worker or namespace.
4. Do not delete the Durable Object namespace until disconnect and secret-removal evidence is recorded. Namespace deletion is destructive and not the normal rollback.

## V2 Per-User Milestone

This is deliberately deferred until shared v1 works and its compatibility risk is accepted.

1. Change backend connection-key derivation from the constant `shared-v1` to an opaque stable user-scoped key.
2. Expose connection management to each authenticated owner instead of administrators only.
3. Project Codex models only for users whose connection is ready.
4. Migrate no refresh token automatically. Each user performs a fresh device login into a distinct Durable Object.
5. Keep the shared connection behind a separate explicit mode during migration, then disconnect and remove it after users move.
6. Add isolation tests proving user A cannot observe, use, disconnect, or infer through user B's connection.

## NOT in Scope

- Public or commercial distribution while using Pi/OMP's OAuth client identity.
- A generic OAuth broker or support for other subscription providers.
- Copying or importing `~/.pi/agent/auth.json`, `~/.codex/auth.json`, or any local credential file.
- Running the OMP broker, Codex CLI, or Codex App Server as a container.
- WebSocket Codex transport.
- PDF inputs before Pi and the ChatGPT backend contract is validated.
- Proactive refresh alarms.
- Remote OpenAI token revocation unless a documented endpoint exists; disconnect guarantees local deletion only.
- AI Gateway routing for Codex subscription traffic.
- Automatic refresh-token migration from shared v1 to per-user v2.
- Reworking existing API-key providers or the general AgentOS agent/sandbox/tool architecture.

## Completion Criteria

The branch is ready to use only when all are true:

- All T1-T10 tasks are checked with command evidence in LOOP_STATE.
- No P1 finding remains open.
- The Pi patch preserves existing consumers and the fork pins it reproducibly.
- OAuth and inference tokens exist only inside the sidecar Durable Object and its upstream request memory.
- Refresh rotation is single-flight and fails closed after ambiguous outcomes.
- The sidecar is unreachable publicly in real preview/deployment configuration.
- Every successful response streams end to end and cancellation reaches upstream.
- All authenticated users can use the shared models; only admins can manage the connection.
- Existing API-key providers and AI Gateway paths pass regressions.
- Preview uses only fake credentials and fake upstreams.
- One canonical live canary passes without recording secrets.
- Rollback and reconnect runbooks have been exercised.

## Review Completion Summary

- Step 0 Scope Challenge: complete scope accepted after explicit complexity review.
- Architecture Review: 4 blocking and 4 non-blocking issues folded into the design.
- Code Quality Review: 4 issues folded in: discriminated config, narrow OAuth port, no generic broker, no duplicated transport/catalog.
- Test Review: coverage diagram produced; distributed auth, crash, stream, and deployment gaps converted to gates.
- Performance Review: 2 issues folded in: shared-DO bottleneck and end-to-end stream buffering/cancellation.
- NOT in scope: written.
- What already exists: written.
- TODOs: per-user V2 milestone accepted and captured; no separate Soulsoft TODO was modified.
- Failure modes: zero silent critical gaps remain in the plan.
- Outside voice: parallel architecture and test reviewers ran.
- Parallelization: 4 Wave 1 lanes; integration and live validation remain sequential.
- Lake Score: 4/4 user decisions chose the complete or recommended implementation path, with shared tenancy intentionally chosen for v1.

## Sources

- [Cloudflare OS issue #89](https://github.com/cloudflare/cloudflare-os/issues/89)
- [Cloudflare Workers service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)
- [Durable Object rules and concurrency](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object testing](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Official Codex device-code implementation](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)
- [Loop engineering](https://addyosmani.com/blog/loop-engineering/)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---:|---:|---|---|
| CEO Review | `/plan-ceo-review` | Scope and strategy | 0 | Not run | User scoped the feature directly. |
| Codex Review | `/codex review` | Independent second opinion | 0 | Not run | Parallel specialist reviews were used instead. |
| Eng Review | `/plan-eng-review` | Architecture and tests | 1 | CLEAR | 14 section findings, consolidated into 10 unique findings; 0 critical gaps remain. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | Not run | Provider UI behavior is specified but not visually designed. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | Not run | Execution commands and loop state are included here. |

**VERDICT:** ENG CLEARED. Ready to execute in the fork against the pinned upstream after the Wave 0 dependency contract probe.

NO UNRESOLVED DECISIONS
