import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/preview.yml", import.meta.url),
  "utf8",
);

function job(name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z][a-z0-9_-]*:\n/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

const trustedOwners =
  /contains\(fromJSON\('\["cloudflare", "brentbaum"\]'\), github\.repository_owner\)/;

describe("preview workflow trust boundary", () => {
  it("uses only pull_request for pull-request code", () => {
    const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\n# Escalated"));
    assert.match(triggers, /^  pull_request:/m);
    assert.doesNotMatch(triggers, /pull_request_target|workflow_run|issue_comment/);
  });

  it("limits every privileged job to the canonical owner or integration fork", () => {
    for (const name of ["deploy", "cleanup", "sweep"]) {
      assert.match(job(name), trustedOwners, `${name} lacks the explicit trusted-owner allowlist`);
    }
    assert.equal(workflow.match(new RegExp(trustedOwners.source, "g"))?.length, 3);
    assert.doesNotMatch(workflow, /github\.repository_owner\s*==/);
  });

  it("keeps pull-request deploy and cleanup same-repository and maintainer-only", () => {
    for (const name of ["deploy", "cleanup"]) {
      const source = job(name);
      assert.match(
        source,
        /github\.event\.pull_request\.head\.repo\.id == github\.event\.pull_request\.base\.repo\.id/,
      );
      assert.match(
        source,
        /contains\(fromJSON\('\["OWNER", "MEMBER", "COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
      );
      assert.match(source, /github\.event\.pull_request\.user\.type != 'Bot'/);
      assert.match(source, /github\.head_ref != 'main'/);
      assert.match(source, /collaborators\/\$PR_AUTHOR\/permission/);
      assert.match(source, /\^\(admin\|maintain\|write\)\$/);
    }
  });

  it("does not expose preview secrets from a pull request outside trusted jobs", () => {
    assert.match(job("deploy"), /secrets\.CLOUDFLARE_API_TOKEN/);
    assert.match(job("cleanup"), /secrets\.CLOUDFLARE_API_TOKEN/);
    assert.match(job("sweep"), /secrets\.CLOUDFLARE_API_TOKEN/);
    assert.equal(
      workflow.match(/CLOUDFLARE_API_TOKEN:\s+\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN/g)?.length,
      3,
    );
  });
});
