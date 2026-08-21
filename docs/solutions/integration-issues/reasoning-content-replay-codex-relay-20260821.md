---
module: Codex Subscription Relay
date: 2026-08-21
problem_type: integration_issue
component: assistant
symptoms:
  - "A GPT-5.6 Sol follow-up or tool continuation failed with Reasoning item field content is not enabled"
  - "The first one or two messages in the same conversation succeeded before a later request failed"
  - "Retrying the failed turn succeeded after output-only reasoning content was removed from replay"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - Pi AI
  - OpenAI Codex Responses
  - AgentOS chat persistence
tags: [codex, reasoning, multi-turn, tool-continuation, pi-ai, responses-api]
---

# Troubleshooting: Codex reasoning content replay breaks later turns

## Problem

The subscription relay completed authentication and successfully streamed initial GPT-5.6 Sol
responses, but a later message in the same AgentOS conversation failed with:

```text
Reasoning item field content is not enabled
```

The failure appeared after the assistant called `listConnectableResources`, so it blocked ordinary
multi-turn use and tool continuations even though single-turn canaries passed.

## Environment

- Module: Codex Subscription Relay
- Stage: Post-implementation live deployment spike
- Pi AI: 0.83.0, installed through a version-pinned pnpm patch
- Transport: AgentOS to private relay to Durable Object to VPC egress host to ChatGPT Codex
- Date: 2026-08-21

## Symptoms

- The first one or two messages in a conversation completed normally.
- A tool call completed, but the continuation request failed with the exact reasoning-field error.
- Authentication remained ready and the request reached an API-shaped Codex response, ruling out
  the earlier Worker-origin challenge.
- Retrying the same failed turn worked after deploying the replay sanitizer.

## What Didn't Work

**Treating the failure as another tunnel or VPC issue**

- **Why it failed:** The upstream returned a specific request-validation error after processing the
  authenticated request. Network egress and the canonical credential owner were both working.

**Dropping the complete reasoning item**

- **Why it was rejected:** Stateless Codex continuation depends on the reasoning item identity and
  encrypted state. Removing `id`, `summary`, or `encrypted_content` would discard valid context and
  risk a different continuation failure.

**Changing the shared OpenAI Responses converter**

- **Why it was rejected:** The invalidity is specific to the ChatGPT Codex input contract. A shared
  change could alter ordinary OpenAI Responses behavior unnecessarily.

## Solution

Pi 0.83.0 saves the completed reasoning output item as the assistant thinking signature. On the
next request, `convertResponsesMessages` parses that signature and reconstructs the reasoning input.
The saved output item includes `content`, commonly an empty array, but the Codex endpoint does not
enable that output-only field on replay.

Sanitize only Codex reasoning inputs immediately after conversion:

```ts
const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
  includeSystemPrompt: false,
  grammarToolInputProperties,
});

for (const item of messages) {
  if (item.type === "reasoning") {
    delete (item as { content?: unknown }).content;
  }
}
```

The version-pinned Pi patch preserves the fields required for continuation:

```json
{
  "id": "rs_reasoning_fake",
  "type": "reasoning",
  "summary": [{ "type": "summary_text", "text": "..." }],
  "encrypted_content": "..."
}
```

It removes only `content` before request compression and dispatch.

A regression test constructs a prior assistant reasoning signature containing `content: []`,
decompresses the next zstd request, and makes the fake upstream return the exact live HTTP 400 when
that field is present. The red test failed before the patch and the same test passed afterward.

## Why This Works

Response output items and subsequent request input items are not always schema-symmetric. Pi was
persisting the complete output item and replaying it verbatim, which leaked an output-only field into
the next request. Removing only `content` satisfies the Codex input contract while retaining the
encrypted reasoning state and item identity needed for stateless continuation.

Keeping the sanitizer in the Codex transport also limits the compatibility change to the endpoint
that demonstrated the restriction.

## Validation Evidence

- Focused Pi external-authorization contract: 6 tests passed, including the red/green reasoning
  replay regression.
- Workshop backend unit suite: 31 files and 350 tests passed.
- Workshop integration suite: 2 tests passed and 4 existing tests remained skipped.
- Cross-package sidecar lifecycle test: 1 test passed.
- Uncached backend build: 4 tasks passed.
- The regenerated package patch contains only the four published Pi artifacts, and both source maps
  embed the exact modified upstream TypeScript source from Pi tag `v0.83.0`.
- The live backend was redeployed without disconnecting or copying the stored credential.
- The user retried the original failed turn in Chrome and confirmed that it completed successfully.

## Prevention

- Make at least one multi-turn conversation with a real tool call part of every live canary; a
  single-turn text response cannot detect replay bugs.
- Test both sides of persisted provider state: the output item that is saved and the later input item
  reconstructed from it.
- Preserve reasoning identifiers and encrypted state, but strip endpoint-specific output-only fields
  at the transport boundary.
- Keep the Pi patch version-pinned and require its contract suite when upgrading Pi; remove the patch
  only after the behavior is available upstream.
- Upstream the Codex-specific sanitizer so the fork does not own this compatibility rule forever.

## Related Issues

- See also: [Worker egress is challenged by the ChatGPT Codex endpoint](worker-egress-challenged-by-chatgpt-codex-relay-20260821.md)
