import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./staging-config.ts";

const SCRIPT = new URL("./preview.ts", import.meta.url);
const FAKE_ACCESS_AUD = "fake-preview-audience-for-tests";
const FAKE_ACCESS_ISS = "https://fake-preview.cloudflareaccess.example";
const FAKE_ADMIN = "fake-admin@example.invalid";
const FAKE_WRAPPING_KEY = Buffer.alloc(32, 23).toString("base64");

function namedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A developer's optional gateway environment must not make this credential-free test vary.
  for (const key of [
    "CF_AI_GATEWAY", "CF_AI_GATEWAY_ACCOUNT_ID", "CF_AI_GATEWAY_API_TOKEN",
    "CF_AI_GATEWAY_PROVIDERS", "CF_AI_GATEWAY_USE_BINDING",
  ]) delete env[key];
  Object.assign(env, {
    PREVIEW_DEPLOY_MODE: "named",
    PREVIEW_NAME: "dry-run-only",
    PREVIEW_PR_NUMBER: "",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    PREVIEW_WORKERS_DEV_HOST: "fake-preview.workers.dev",
    PREVIEW_ADMINS: FAKE_ADMIN,
    CF_ACCESS_AUD: FAKE_ACCESS_AUD,
    CF_ACCESS_ISS: FAKE_ACCESS_ISS,
    PREVIEW_CODEX_WRAPPING_KEY: FAKE_WRAPPING_KEY,
  });
  return env;
}

function namedDryRun(command: "deploy" | "delete" | "sweep") {
  const env = namedEnvironment();
  // A dry run must return before preparing or invoking Wrangler.
  env.PREVIEW_WRANGLER = "/definitely/not/a/real/wrangler";
  return spawnSync(process.execPath, [SCRIPT.pathname, command, "--dry-run"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
}

test("named deploy dry-run shows dependency tiers without invoking Wrangler or printing secrets", () => {
  const result = namedDryRun("deploy");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run plan for named fallback "dry-run-only"/);
  assert.match(result.stdout, /tier 1/);
  assert.match(result.stdout, /tier 2: dry-run-only-codex-relay/);
  assert.match(result.stdout, /tier 3: dry-run-only-workshop-backend/);
  assert.match(result.stdout, /tier 4: dry-run-only-router/);
  assert.match(result.stdout, /stable workers\.dev hostname; version-preview URLs are off/);
  assert.match(result.stdout, /sent only over wrangler secret bulk stdin/);
  for (const secret of [FAKE_ACCESS_AUD, FAKE_ACCESS_ISS, FAKE_ADMIN, FAKE_WRAPPING_KEY]) {
    assert.ok(!result.stdout.includes(secret), `dry-run printed secret value ${secret}`);
    assert.ok(!result.stderr.includes(secret), `dry-run stderr printed secret value ${secret}`);
  }
});

test("named deploy uses ordinary Wrangler tiers and passes every secret only on stdin", () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "named-preview-test-"));
  const log = join(fakeDir, "calls.jsonl");
  const fake = join(fakeDir, "fake-command");
  const fakeSource = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_COMMAND_LOG,
  JSON.stringify({ command: path.basename(process.argv[1]), cwd: process.cwd(),
    args: process.argv.slice(2), input }) + "\\n");
`;
  writeFileSync(fake, fakeSource);
  chmodSync(fake, 0o755);
  writeFileSync(join(fakeDir, "pnpm"), fakeSource);
  chmodSync(join(fakeDir, "pnpm"), 0o755);

  try {
    const env = namedEnvironment();
    Object.assign(env, {
      PREVIEW_WRANGLER: fake,
      FAKE_COMMAND_LOG: log,
      PATH: `${fakeDir}:${env.PATH ?? ""}`,
    });
    const result = spawnSync(process.execPath, [SCRIPT.pathname, "deploy"], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as {
        command: string;
        cwd: string;
        args: string[];
        input: string;
      });
    const wranglerCalls = calls.filter(({ command }) => command === "fake-command");
    assert.ok(wranglerCalls.length > 0);
    assert.ok(wranglerCalls.every(({ args }) => args[0] !== "preview"),
        "named mode invoked the Worker Previews API");
    assert.ok(wranglerCalls.every(({ args }) =>
      !args.some((arg) => [FAKE_ACCESS_AUD, FAKE_ACCESS_ISS, FAKE_ADMIN, FAKE_WRAPPING_KEY]
        .some((secret) => arg.includes(secret)))), "a secret was passed on argv");

    const indexOf = (pkg: string, command: string) => wranglerCalls.findIndex((call) =>
      call.cwd.endsWith(`/packages/${pkg}`) && call.args[0] === command);
    const relayDeploy = indexOf("codex-relay", "deploy");
    const backendDeploy = indexOf("workshop-backend", "deploy");
    const routerDeploy = indexOf("router", "deploy");
    assert.ok(relayDeploy > indexOf("codex-relay/__fixtures__/fake-upstream", "deploy"));
    assert.ok(backendDeploy > relayDeploy);
    assert.ok(routerDeploy > backendDeploy);
    assert.equal(routerDeploy, wranglerCalls.length - 1, "router was not the final Wrangler call");

    const secretCalls = wranglerCalls.filter(({ args }) =>
      args[0] === "secret" && args[1] === "bulk");
    assert.equal(secretCalls.length, 2);
    const combinedInput = secretCalls.map(({ input }) => input).join("\n");
    for (const secret of [FAKE_ACCESS_AUD, FAKE_ACCESS_ISS, FAKE_ADMIN, FAKE_WRAPPING_KEY]) {
      assert.ok(combinedInput.includes(secret), `${secret} was not sent on secret-bulk stdin`);
    }
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }
});

test("named delete dry-run is exact-prefix scoped and preserves unrelated resources", () => {
  const result = namedDryRun("delete");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would delete named fallback "dry-run-only"/);
  assert.match(result.stdout, /dry-run-only-router/);
  assert.match(result.stdout, /dry-run-only-gatekeeper-context-context-collections/);
  assert.match(result.stdout, /dry-run-only-workshop-backend-blueprint-content/);
  assert.doesNotMatch(result.stdout, /moltbot-data|captains-log/);
});

test("named delete removes dependents before exact resources and never selects unrelated names", () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "named-delete-test-"));
  const log = join(fakeDir, "calls.jsonl");
  const fetchLog = join(fakeDir, "fetch.jsonl");
  const fake = join(fakeDir, "fake-wrangler");
  const loader = join(fakeDir, "fake-fetch.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_COMMAND_LOG,
  JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input }) + "\\n");
`);
  chmodSync(fake, 0o755);
  writeFileSync(loader, `
import fs from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  fs.appendFileSync(process.env.FAKE_FETCH_LOG,
    JSON.stringify({ url: String(url), method: init.method || "GET" }) + "\\n");
  return new Response(JSON.stringify({ success: true, result: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
`);

  try {
    const env = namedEnvironment();
    Object.assign(env, {
      PREVIEW_WRANGLER: fake,
      CLOUDFLARE_API_TOKEN: "fake-cloudflare-token-for-tests",
      FAKE_COMMAND_LOG: log,
      FAKE_FETCH_LOG: fetchLog,
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${loader}`.trim(),
    });
    const result = spawnSync(process.execPath, [SCRIPT.pathname, "delete"], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { cwd: string; args: string[]; input: string });
    const workerDeletes = calls.filter(({ args }) => args[0] === "delete");
    assert.equal(workerDeletes.length, 20);
    assert.equal(workerDeletes[0].args[1], "dry-run-only-router");
    assert.equal(workerDeletes[1].args[1], "dry-run-only-workshop-backend");
    assert.equal(workerDeletes[2].args[1], "dry-run-only-codex-relay");
    const firstResource = calls.findIndex(({ args }) => ["kv", "r2", "d1"].includes(args[0]));
    const lastWorker = calls.findLastIndex(({ args }) => args[0] === "delete");
    assert.ok(firstResource > lastWorker, "resource cleanup began before every Worker was deleted");
    const resourceArgs = calls.slice(firstResource).map(({ args }) => args.join(" ")).join("\n");
    for (const expected of [
      "dry-run-only-gatekeeper-context-context-collections",
      "dry-run-only-workshop-backend-blueprints",
      "dry-run-only-workshop-backend-avatars",
      "dry-run-only-workshop-backend-blueprint-content",
    ]) assert.ok(resourceArgs.includes(expected), `cleanup omitted ${expected}`);
    assert.doesNotMatch(resourceArgs, /moltbot-data|captains-log/);
    assert.ok(calls.every(({ input }) => input === ""), "delete passed data on child stdin");

    const fetches = readFileSync(fetchLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { url: string; method: string });
    assert.deepEqual(fetches, [{
      url: `https://api.cloudflare.com/client/v4/accounts/${"0".repeat(32)}/r2/buckets/` +
        "dry-run-only-workshop-backend-blueprint-content/objects?limit=1000",
      method: "GET",
    }]);
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }
});

test("named mode refuses a broad account sweep", () => {
  const result = namedDryRun("sweep");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not support account-wide sweep/);
  assert.match(result.stderr, /cleanup stays exact-prefix scoped/);
});
