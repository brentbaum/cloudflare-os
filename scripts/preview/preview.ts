#!/usr/bin/env node

// Deploys, or tears down, a complete instance as a set of Cloudflare Worker Previews — one per
// pull request — on the account named by CLOUDFLARE_ACCOUNT_ID.
//
//   node scripts/preview/preview.ts config          regenerate wrangler.staging.jsonc only
//   node scripts/preview/preview.ts deploy          build + deploy the preview instance
//   node scripts/preview/preview.ts delete          tear it down
//   node scripts/preview/preview.ts sweep           tear down every abandoned preview
//   ... --dry-run                                    print the plan, touch no network
//
// Deployment runs in four tiers, because each tier's service bindings must name the previews the
// tier before it produced:
//
//   1. the 16 gatekeepers and fake Codex upstream (concurrently; no cross-bindings)
//   2. codex-relay         (binds only the fake Codex upstream)
//   3. workshop-backend    (binds every gatekeeper preview and the private Codex relay)
//   4. router              (binds the backend preview and every gatekeeper preview, and owns the
//                           public origin: it serves the frontend and proxies /api and
//                           /gatekeeper/<short>)
//
// Between tiers the next tier's `previews.services[].preview_id` is patched with the ids the
// previous tier returned. Everything else — every URL in the config — is derived up front from
// the router's preview name, which is deterministic, so the tiers only have to exchange ids.
//
// The router is the only one of the twenty with a hostname. In Worker Preview mode that is its
// preview URL. In named fallback mode it is the stable workers.dev hostname and even the router
// sets `preview_urls: false`, because version-preview hostnames would bypass an exact-hostname
// Access app. Every other Worker is reached over service bindings alone.
//
// The backend's secrets — its admins and the Cloudflare Access application that authenticates the
// instance — are uploaded to the worker's Previews settings between tiers 1 and 2 and are never
// written into a config, because Wrangler prints config values and this workflow's logs are public.
// See uploadSecrets, and backendSecrets in staging-config.ts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  ROOT,
  STAGING_CONFIG_NAME,
  assertNamedResourceScope,
  backendSecrets,
  codexRelaySecrets,
  gatekeeperShortName,
  generatePreviewConfigs,
  isGatekeeper,
  namedAutoResources,
  previewPullRequestNumber,
  previewUrlFor,
  resolvePreviewDeployMode,
  resolvePreviewName,
  writePreviewConfig,
  type DeployablePackage,
  type NamedAutoResource,
  type PreviewDeployMode,
  type StagingConfig,
} from "./staging-config.ts";

/** The subcommands this script accepts. */
type Command = "config" | "deploy" | "delete" | "sweep";

/** A finished child process: its exit status and the output it produced. */
interface CommandResult {
  /** Exit code, or null if the process was killed by a signal. */
  status: number | null;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/** The Wrangler build a run uses, and how to dispose of it (see WRANGLER_PACKAGE). */
interface PreviewWrangler {
  /** The `wrangler` binary to invoke. */
  command: string;
  /** Resolves once the binary is installed and usable. */
  ready: Promise<void>;
  /** Removes the temporary install, if there is one. */
  cleanup: () => void;
}

/** What one deployed Worker Preview reports back. */
interface DeployedPreview {
  /** The preview id a sibling preview's service binding points at. */
  id: string;
  /** The preview's slug, as Wrangler named it. */
  slug: string;
  /** Its public URL, if it has one. Only the router does. */
  url: string | undefined;
  /** Wrangler's raw stdout, kept for diagnostics. */
  output: string;
}

/** The `--json` payload `wrangler preview` emits. */
interface WranglerPreviewJson {
  preview?: { id?: string; slug?: string; urls?: string[] };
}

/** The credential forms `wrangler auth token --json` can report. */
interface WranglerAuthJson {
  type?: "oauth" | "api_token" | "api_key";
  token?: string;
}

/** One preview as the Cloudflare API lists it, for the sweep. */
interface ListedPreview {
  /** The preview name: `pr<n>-<slugified branch>`, or the bare slug for a local deploy. */
  name: string;
  created_on?: string;
  created_at?: string;
  modified_on?: string;
}

/** One preview of a given name, as the sweep indexes it across every worker. */
interface IndexedPreview {
  /** The workers that carry it — the ones a teardown has to delete it from. */
  workers: DeployablePackage[];
  /** Age in days of the *newest* copy, or null if none of them reported a timestamp. */
  age: number | null;
}

/**
 * What the sweep knows about a preview's pull request. GitHub reports the first two ("closed" covers
 * merged); `missing` is a 404 — a number naming no pull request — and `unknown` is a preview with no
 * number in its name, or a request that failed.
 */
type PullRequestState = "open" | "closed" | "missing" | "unknown";

/** One pull request as the sweep reads it: whether it is still open. */
interface FetchedPullRequest {
  /** "open", or "closed" — which covers merged. */
  state?: string;
}

const USAGE = "Usage: preview.ts <config|deploy|delete|sweep> [--dry-run]";
const OUTPUT_DIR = join(ROOT, "output");
const PREVIEW_COMMENT = join(OUTPUT_DIR, "preview-comment.md");
const GATEKEEPER_CONCURRENCY = 8;
// How many of the sweep's read-only API requests — one preview list per worker, one pull request per
// number — are in flight at once.
const API_CONCURRENCY = 8;

// Worker Previews are in private beta, and two of the features this script is built on are not in
// any released Wrangler: per-preview resource auto-provisioning (`previews.kv_namespaces` etc.
// declared binding-only), and `preview_id` on a `previews.services` entry, which is what points a
// preview at a *sibling* preview rather than at the baseline worker. Verified 2026-08-16 against
// the pinned 4.120.0 and the then-latest 4.123.0: both accept a binding-only KV entry in the
// schema but send `namespace_id: undefined`, and both silently drop `preview_id` from a service
// binding — which would leave the whole instance wired to the baselines. So the deploy runs on
// the draft build from https://github.com/cloudflare/workers-sdk/pull/14416 instead, installed
// into a tmpdir. It pulls matching workers-sdk workspace packages from pkg.pr.new, hence the
// exotic-subdeps opt-out.
//
// Drop all of this — and set PREVIEW_WRANGLER=pnpm-exec-wrangler in the meantime to check — once
// both features ship: `preview_id` appearing in a released `config-schema.json` under
// `PreviewsConfig.properties.services.items.properties` is the signal.
const WRANGLER_PACKAGE = "https://pkg.pr.new/wrangler@14416";

function parseArgs(argv: string[]): { command: Command; dryRun: boolean } {
  const command = argv[0] as Command;
  if (!["config", "deploy", "delete", "sweep"].includes(command)) throw new Error(USAGE);
  const unknown = argv.slice(1).filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}\n${USAGE}`);
  return { command, dryRun: argv.includes("--dry-run") };
}

function runAsync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  console.log(`running: ${command} ${args.join(" ")}`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

// Every item is attempted even after one fails
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let nextIndex = 0;
  let firstError: unknown;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (firstError === undefined) firstError = error;
        else console.error(`Additional concurrent failure: ${describe(error)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (firstError !== undefined) throw firstError;
  return results;
}

async function waitForAll(promises: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  for (const failure of failures.slice(1)) {
    console.error(`Additional concurrent failure: ${describe(failure)}`);
  }
  if (failures.length > 0) throw failures[0];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Codegen, the frontend bundle the router serves, and each gatekeeper's SPA bundle. Vite+ caches
// per task, so this is cheap on a warm tree.
//
// Whether the UI signs in through Cloudflare Access or with a password is a build-time flag
// (workshop-frontend/src/useAuth.ts), so a preview needs the same one build-release.mjs sets:
// otherwise it serves a password form the backend rejects every password from. The frontend's
// `build` task already declares `env: ['VITE_*']`.
function buildWorkspace(): Promise<void> {
  return runAsync("pnpm", ["run", "build"],
      { cwd: ROOT, env: { ...process.env, VITE_CF_ACCESS_MODE: "true" } });
}

function preparePreviewWrangler(deployMode: PreviewDeployMode = "preview"): PreviewWrangler {
  const override = process.env.PREVIEW_WRANGLER;
  if (override) {
    return { command: override, ready: Promise.resolve(), cleanup: () => {} };
  }
  // Named mode uses no private-beta commands or config. Keep it on the repository's released,
  // pinned Wrangler, whose `auth token --json` is also the supported bridge to a local OAuth login.
  if (deployMode === "named") {
    return {
      command: join(ROOT, "node_modules", ".bin", "wrangler"),
      ready: Promise.resolve(),
      cleanup: () => {},
    };
  }

  const installDir = mkdtempSync(join(tmpdir(), "preview-wrangler-"));
  try {
    writeFileSync(join(installDir, "package.json"), JSON.stringify({
      private: true,
      dependencies: { wrangler: WRANGLER_PACKAGE },
    }));
    writeFileSync(join(installDir, "pnpm-workspace.yaml"),
        "allowBuilds:\n  esbuild: true\n  sharp: true\n  workerd: true\n");
  } catch (error) {
    rmSync(installDir, { recursive: true, force: true });
    throw error;
  }

  return {
    command: join(installDir, "node_modules", ".bin", "wrangler"),
    ready: runAsync("pnpm",
        ["--config.blockExoticSubdeps=false", "--dir", installDir, "install"]),
    cleanup: () => rmSync(installDir, { recursive: true, force: true }),
  };
}

function readConfig(pkgDir: string): StagingConfig {
  return JSON.parse(readFileSync(join(pkgDir, STAGING_CONFIG_NAME), "utf8")) as StagingConfig;
}

// Wrangler's prose and its `code: 10007`, plus the `"code":10007` the Cloudflare API returns — the
// sweep lists previews over that API, and a worker whose baseline was never deployed has none.
function isMissingWorkerError(output: string): boolean {
  return /This Worker does not exist on your account|code"?:\s*10007/i.test(output);
}

// `wrangler --json` still logs informational text to stdout ahead of the JSON object, but the
// payload is emitted last.
function parseWranglerJson(raw: string): WranglerPreviewJson {
  const start = raw.lastIndexOf("\n{");
  const jsonStart = start >= 0 ? start + 1 : raw.indexOf("{");
  if (jsonStart >= 0) {
    const parsed = JSON.parse(raw.slice(jsonStart)) as WranglerPreviewJson;
    if (parsed.preview) return parsed;
  }
  throw new Error("Failed to parse wrangler JSON output: " +
      (jsonStart < 0 ? "no JSON payload found" : "no preview JSON payload found"));
}

function runWrangler(
  pkg: DeployablePackage,
  wranglerCommand: string,
  args: string[],
  // Written to the child's stdin, which is how secret values are handed over: argv is visible in
  // `ps` output and is echoed by the `running:` lines above every invocation.
  input?: string,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(wranglerCommand, args, {
      cwd: pkg.dir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Closed immediately either way: no command here reads stdin except `secret bulk`, and an
    // empty pipe is the same EOF the previous `ignore` produced.
    child.stdin.end(input ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { stdout += data; });
    child.stderr.on("data", (data: string) => { stderr += data; });
    child.once("error",
        (error) => reject(new Error(`Failed to run Wrangler for ${pkg.name}: ${error.message}`)));
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function writeCommandOutput(pkg: DeployablePackage, { stdout, stderr }: CommandResult): void {
  if (stdout) process.stdout.write(`[${pkg.name}]\n${stdout}`);
  if (stderr) process.stderr.write(`[${pkg.name}]\n${stderr}`);
}

// A Worker Preview is a branch of a baseline worker, so the baseline has to exist. Rather than
// requiring a separate bootstrap, deploy it the first time a preview reports it missing.
async function deployBaselineWorker(
  pkg: DeployablePackage,
  wranglerCommand: string,
): Promise<void> {
  console.log(`baseline worker missing; running in ${pkg.name}: ` +
      `wrangler deploy -c ${STAGING_CONFIG_NAME}`);
  const result = await runWrangler(pkg, wranglerCommand, ["deploy", "-c", STAGING_CONFIG_NAME]);
  writeCommandOutput(pkg, result);
  if (result.status !== 0) {
    throw new Error(
        `wrangler deploy failed for baseline worker ${pkg.name} with exit code ${result.status}`);
  }
}

/** Deploy one uniquely named ordinary Worker. Its generated config already names every sibling. */
async function deployNamedWorker(
  pkg: DeployablePackage,
  wranglerCommand: string,
): Promise<void> {
  const config = readConfig(pkg.dir);
  console.log(`running in ${pkg.name}: wrangler deploy -c ${STAGING_CONFIG_NAME} ` +
      `(ordinary worker ${config.name})`);
  const result = await runWrangler(pkg, wranglerCommand, ["deploy", "-c", STAGING_CONFIG_NAME]);
  writeCommandOutput(pkg, result);
  if (result.status !== 0) {
    throw new Error(`wrangler deploy failed for named worker ${config.name} with exit code ` +
        `${result.status}`);
  }
}

/**
 * Give a worker its secrets — the backend's admins and Cloudflare Access pair (see
 * backendSecrets). None of them is in the generated config, because Wrangler prints the values it
 * finds there and this workflow's logs are public; `secret bulk` prints only names and `********`,
 * and the values arrive on stdin rather than in argv.
 *
 * `preview secret bulk` writes the *Worker's Previews settings*, which every preview of that worker
 * inherits, so one upload covers every preview and each run refreshes them. The plain `secret bulk`
 * form is for the baseline worker itself, which is a real, publicly reachable instance and needs
 * the same Access application in front of it.
 */
async function uploadSecrets(
  pkg: DeployablePackage,
  wranglerCommand: string,
  secrets: Record<string, string>,
  { previews }: { previews: boolean },
): Promise<CommandResult> {
  const args = [...previews ? ["preview"] : [], "secret", "bulk", "-c", STAGING_CONFIG_NAME];
  console.log(`running in ${pkg.name}: wrangler ${args.join(" ")} ` +
      `(${Object.keys(secrets).join(", ")} on stdin)`);
  const result = await runWrangler(pkg, wranglerCommand, args, JSON.stringify(secrets));
  writeCommandOutput(pkg, result);
  return result;
}

/**
 * Upload the backend's secrets, creating its baseline worker first if it does not exist yet.
 *
 * This runs before the backend's own preview rather than relying on deployPreview's self-heal,
 * because a worker has no Previews settings to write to until it exists — and a preview created
 * before the settings existed would come up with no admins and, worse, no Access application, so it
 * would fall back to password signup on a public URL.
 */
async function uploadPreviewSecrets(
  worker: DeployablePackage,
  wranglerCommand: string,
  secrets: Record<string, string>,
): Promise<void> {
  let result = await uploadSecrets(worker, wranglerCommand, secrets, { previews: true });
  if (result.status !== 0 && isMissingWorkerError(`${result.stdout}\n${result.stderr}`)) {
    await deployBaselineWorker(worker, wranglerCommand);
    // The baseline is briefly live without these, but it is only reachable through the *baseline*
    // router — which is deployed after it, later in the same first run.
    const baseline = await uploadSecrets(worker, wranglerCommand, secrets, { previews: false });
    if (baseline.status !== 0) {
      throw new Error(`wrangler secret bulk failed for baseline worker ${worker.name} with exit ` +
          `code ${baseline.status}`);
    }
    result = await uploadSecrets(worker, wranglerCommand, secrets, { previews: true });
  }
  if (result.status !== 0) {
    throw new Error(`wrangler preview secret bulk failed for ${worker.name} with exit code ` +
        `${result.status}`);
  }
}

/** Ordinary named Workers receive ordinary secrets, still serialized only onto stdin. */
async function uploadNamedSecrets(
  worker: DeployablePackage,
  wranglerCommand: string,
  secrets: Record<string, string>,
): Promise<void> {
  const result = await uploadSecrets(worker, wranglerCommand, secrets, { previews: false });
  if (result.status !== 0) {
    throw new Error(`wrangler secret bulk failed for named worker ${readConfig(worker.dir).name} ` +
        `with exit code ${result.status}`);
  }
}

/**
 * Resolve a Bearer token without persisting or displaying it. Wrangler's released `auth token`
 * command reads the same OAuth login as ordinary deploy commands; `--json` suppresses its banner,
 * and this caller deliberately never forwards the captured stdout/stderr to logs.
 */
async function namedCleanupBearerToken(
  worker: DeployablePackage,
  wranglerCommand: string,
): Promise<string> {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const result = await runWrangler(
      worker, wranglerCommand, ["auth", "token", "--json", "-c", STAGING_CONFIG_NAME]);
  if (result.status !== 0) {
    throw new Error("named R2 cleanup needs Cloudflare authentication, but Wrangler could not " +
        "retrieve its current OAuth token; run `wrangler login` or set CLOUDFLARE_API_TOKEN");
  }
  let credential: WranglerAuthJson;
  try {
    credential = JSON.parse(result.stdout) as WranglerAuthJson;
  } catch {
    // Never include stdout in this error: a malformed response could still contain a credential.
    throw new Error("Wrangler returned an unreadable authentication response for named cleanup");
  }
  if ((credential.type !== "oauth" && credential.type !== "api_token") ||
      typeof credential.token !== "string" || credential.token.length === 0) {
    throw new Error("Wrangler authentication cannot provide the Bearer token named R2 cleanup " +
        "requires; use Wrangler OAuth or CLOUDFLARE_API_TOKEN");
  }
  return credential.token;
}

async function runPreviewCommand(
  pkg: DeployablePackage,
  previewName: string,
  wranglerCommand: string,
): Promise<CommandResult> {
  console.log(`running in ${pkg.name}: ` +
      `wrangler preview --name ${previewName} -c ${STAGING_CONFIG_NAME} --json`);
  const result = await runWrangler(pkg, wranglerCommand,
      ["preview", "--name", previewName, "-c", STAGING_CONFIG_NAME, "--json"]);
  if (result.stderr) process.stderr.write(`[${pkg.name}]\n${result.stderr}`);
  return result;
}

async function deployPreview(
  pkg: DeployablePackage,
  previewName: string,
  wranglerCommand: string,
): Promise<DeployedPreview> {
  let result = await runPreviewCommand(pkg, previewName, wranglerCommand);
  if (result.status !== 0 && isMissingWorkerError(`${result.stdout}\n${result.stderr}`)) {
    await deployBaselineWorker(pkg, wranglerCommand);
    result = await runPreviewCommand(pkg, previewName, wranglerCommand);
  }
  if (result.status !== 0) {
    throw new Error(`wrangler preview failed for ${pkg.name} with exit code ${result.status}`);
  }

  const data = parseWranglerJson(result.stdout);
  // The id is what a sibling preview binds to, so it is required of every worker. A URL is not:
  // only the router sets `preview_urls`, and the other nineteen are reached over service
  // bindings alone.
  if (!data.preview?.id) throw new Error(`Wrangler did not emit a preview id for ${pkg.name}`);
  return {
    id: data.preview.id,
    slug: data.preview.slug ?? previewName,
    url: data.preview.urls?.[0],
    output: result.stdout,
  };
}

async function deletePreview(
  pkg: DeployablePackage,
  previewName: string,
  wranglerCommand: string,
): Promise<void> {
  console.log(`running in ${pkg.name}: ` +
      `wrangler preview delete --name ${previewName} -c ${STAGING_CONFIG_NAME} -y`);
  const result = await runWrangler(pkg, wranglerCommand,
      ["preview", "delete", "--name", previewName, "-c", STAGING_CONFIG_NAME, "-y"]);
  writeCommandOutput(pkg, result);
  if (result.status === 0) return;

  // Deleting a preview that was never created — a PR closed before its first deploy finished, a
  // re-run of the cleanup job — is the expected case, not a failure.
  const output = `${result.stdout}\n${result.stderr}`;
  if (/not found|does not exist|10007|10025|10222/i.test(output)) {
    console.warn(`Preview ${previewName} for ${pkg.name} did not exist; continuing.`);
    return;
  }
  throw new Error(
      `wrangler preview delete failed for ${pkg.name} with exit code ${result.status}`);
}

async function deleteNamedWorker(
  pkg: DeployablePackage,
  wranglerCommand: string,
): Promise<void> {
  const workerName = readConfig(pkg.dir).name;
  if (!workerName) throw new Error(`${pkg.name}'s generated named config has no worker name`);
  console.log(`running in ${pkg.name}: wrangler delete ${workerName} ` +
      `-c ${STAGING_CONFIG_NAME} --force`);
  const result = await runWrangler(pkg, wranglerCommand,
      ["delete", workerName, "-c", STAGING_CONFIG_NAME, "--force"]);
  writeCommandOutput(pkg, result);
  if (result.status === 0) return;
  if (/not found|does not exist|10007/i.test(`${result.stdout}\n${result.stderr}`)) {
    console.warn(`Named worker ${workerName} did not exist; continuing.`);
    return;
  }
  throw new Error(`wrangler delete failed for named worker ${workerName} with exit code ` +
      `${result.status}`);
}

async function deleteNamedWorkers(
  workers: readonly DeployablePackage[],
  wranglerCommand: string,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (pkg: DeployablePackage) => {
    try {
      await deleteNamedWorker(pkg, wranglerCommand);
    } catch (error) {
      failures.push(error);
    }
  };
  const named = (name: string) => workers.filter((pkg) => pkg.name === name);
  for (const pkg of [
    ...named("router"), ...named("workshop-backend"), ...named("codex-relay"),
  ]) await attempt(pkg);
  await mapWithConcurrency(
      workers.filter((pkg) =>
        !["router", "workshop-backend", "codex-relay"].includes(pkg.name)),
      GATEKEEPER_CONCURRENCY, attempt);
  for (const failure of failures.slice(1)) {
    console.error(`Additional failure deleting named worker: ${describe(failure)}`);
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Delete one preview from every worker that carries it.
 *
 * Dependents first — router, backend, relay, then the rest concurrently — so nothing is left bound
 * to a preview that no longer exists.
 */
async function deletePreviewFrom(
  workers: readonly DeployablePackage[],
  previewName: string,
  wranglerCommand: string,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (pkg: DeployablePackage) => {
    try {
      await deletePreview(pkg, previewName, wranglerCommand);
    } catch (error) {
      failures.push(error);
    }
  };

  const named = (name: string) => workers.filter((pkg) => pkg.name === name);
  for (const pkg of [
    ...named("router"), ...named("workshop-backend"), ...named("codex-relay"),
  ]) await attempt(pkg);
  await mapWithConcurrency(
      workers.filter((pkg) =>
        !["router", "workshop-backend", "codex-relay"].includes(pkg.name)),
      GATEKEEPER_CONCURRENCY, attempt);

  for (const failure of failures.slice(1)) {
    console.error(`Additional failure deleting ${previewName}: ${describe(failure)}`);
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Rewrite one package's `previews.services[].preview_id` from a map of **worker name** to preview
 * id, leaving entries the map doesn't mention alone (the router is patched twice — once for the
 * gatekeepers, once for the backend).
 */
function patchPreviewServiceBindings(
  pkg: DeployablePackage,
  previewIds: Record<string, string>,
): void {
  const config = readConfig(pkg.dir);
  const services = config.previews?.services;
  if (!config.previews || !Array.isArray(services)) {
    throw new Error(`${pkg.name} preview config declares no service bindings to patch`);
  }

  const matched = new Set<string>();
  config.previews.services = services.map((service) => {
    if (!Object.hasOwn(previewIds, service.service)) return service;
    matched.add(service.service);
    return { ...service, preview_id: previewIds[service.service] };
  });

  // An unmatched key means the deployed worker's name and the name in the binding have drifted
  // apart. Left unchecked that is silent: the binding keeps no preview_id and resolves to the
  // baseline worker, so the instance comes up looking healthy and wired to the wrong code.
  const unmatched = Object.keys(previewIds).filter((name) => !matched.has(name));
  if (unmatched.length > 0) {
    throw new Error(`${pkg.name} has no service binding for ${unmatched.join(", ")}; its ` +
        `bindings name ${services.map((s) => s.service).join(", ")}`);
  }
  writePreviewConfig(pkg.dir, config);
}

// Only the router has a URL, and every BASE_URL in the instance was derived from that hostname
// before anything deployed — so a mismatch means the whole preview is misconfigured rather than
// merely oddly named. A worker with no `preview_urls` reports no URL at all, which is expected.
function assertRouterPreviewUrl(
  pkg: DeployablePackage,
  previewName: string,
  workersDevHost: string,
  actualUrl: string | undefined,
): asserts actualUrl is string {
  const expected = previewUrlFor(pkg.name, previewName, workersDevHost);
  if (actualUrl !== expected) {
    throw new Error(
        `Expected preview URL ${expected} for ${pkg.name}, but Wrangler returned ${actualUrl}`);
  }
}

function assertNoPreviewUrl(pkg: DeployablePackage, actualUrl: string | undefined): void {
  if (actualUrl) {
    // Preview URLs are public. Only the router should be reachable directly, so one appearing on
    // a service-bound worker is a routing hole, not a cosmetic surprise.
    throw new Error(`${pkg.name} was given the public preview URL ${actualUrl}, but only the ` +
        "router should have one; check that its config still sets preview_urls: false");
  }
}

function writePreviewComment(
  baseUrl: string,
  slug: string,
  accountId: string | undefined,
  { deployMode = "preview", workerName = "router" }: {
    deployMode?: PreviewDeployMode;
    workerName?: string;
  } = {},
): void {
  const dashboardUrl = `https://dash.cloudflare.com/${accountId}/workers/services/view/` +
      `${workerName}/production` + (deployMode === "preview" ? `/previews/${slug}` : "");
  // The slug is the PR number and the branch, so it is worth showing: it is the URL's first label.
  const comment = [
    `### Preview: \`${slug}\``,
    "",
    baseUrl,
    "",
    `[Dashboard](${dashboardUrl}) · deleted when this PR closes`,
  ].join("\n");

  mkdirSync(dirname(PREVIEW_COMMENT), { recursive: true });
  writeFileSync(PREVIEW_COMMENT, comment + "\n");
  console.log(`\nWrote ${PREVIEW_COMMENT}`);
}

function tiers(packages: readonly DeployablePackage[]): {
  gatekeepers: DeployablePackage[];
  codexFakeUpstream: DeployablePackage;
  codexRelay: DeployablePackage;
  backend: DeployablePackage;
  router: DeployablePackage;
} {
  const byName = (name: string): DeployablePackage => {
    const pkg = packages.find((p) => p.name === name);
    if (!pkg) throw new Error(`missing deployable package: ${name}`);
    return pkg;
  };
  return {
    gatekeepers: packages.filter((pkg) => isGatekeeper(pkg.name))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    codexFakeUpstream: byName("codex-fake-upstream"),
    codexRelay: byName("codex-relay"),
    backend: byName("workshop-backend"),
    router: byName("router"),
  };
}

async function deploy({ dryRun }: { dryRun: boolean }): Promise<void> {
  // First, before a single config is written: a missing CF_ACCESS_AUD/CF_ACCESS_ISS has to fail
  // here rather than after twenty previews are live with whatever auth they defaulted to.
  const secrets = backendSecrets();
  const relaySecrets = codexRelaySecrets();
  const deployMode = resolvePreviewDeployMode();
  const { previewName, workersDevHost, baseUrl, packages } =
    generatePreviewConfigs({ deployMode });
  const { gatekeepers, codexFakeUpstream, codexRelay, backend, router } = tiers(packages);

  if (dryRun) {
    console.log(`\ndry-run plan for ${deployMode === "named" ? "named fallback" : "preview"} ` +
        `"${previewName}" at ${baseUrl}:`);
    console.log(`  tier 1 (${gatekeepers.length} gatekeepers + fake Codex upstream, concurrently):`);
    for (const pkg of gatekeepers) {
      console.log(`    ${readConfig(pkg.dir).name} ` +
          `(no hostname; served at ${baseUrl}/gatekeeper/${gatekeeperShortName(pkg.name)})`);
    }
    console.log(`    ${readConfig(codexFakeUpstream.dir).name} (no hostname; fake data only)`);
    console.log(`  tier 2: ${readConfig(codexRelay.dir).name} ` +
        `(no hostname; bound only to fake upstream)`);
    console.log(`  tier 3: ${readConfig(backend.dir).name} (no hostname; served at ` +
        `${baseUrl}/api), bound to the tier 1 previews, holding the ` +
        `${Object.keys(secrets).join(", ")} secrets`);
    console.log(`  tier 4: ${readConfig(router.dir).name} -> ${baseUrl}, ` +
        "bound to every preview above");
    if (deployMode === "named") {
      console.log("  deploys ordinary Workers; service bindings use the unique sibling names");
      console.log("  router uses its stable workers.dev hostname; version-preview URLs are off");
      console.log(`  secrets (${Object.keys({ ...secrets, ...relaySecrets }).join(", ")}) ` +
          "are sent only over wrangler secret bulk stdin");
    }
    return;
  }

  const wrangler = preparePreviewWrangler(deployMode);
  try {
    await waitForAll([wrangler.ready, buildWorkspace()]);

    if (deployMode === "named") {
      await mapWithConcurrency([...gatekeepers, codexFakeUpstream], GATEKEEPER_CONCURRENCY,
          (pkg) => deployNamedWorker(pkg, wrangler.command));
      await deployNamedWorker(codexRelay, wrangler.command);
      await uploadNamedSecrets(codexRelay, wrangler.command, relaySecrets);
      await deployNamedWorker(backend, wrangler.command);
      await uploadNamedSecrets(backend, wrangler.command, secrets);
      await deployNamedWorker(router, wrangler.command);

      const routerName = readConfig(router.dir).name;
      console.log(`\nNamed fallback "${previewName}" is live at ${baseUrl}`);
      writePreviewComment(baseUrl, previewName, readConfig(router.dir).account_id,
          { deployMode, workerName: routerName });
      return;
    }

    // Keyed by worker name, because that is what a service binding names.
    const gatekeeperPreviews = await mapWithConcurrency(gatekeepers, GATEKEEPER_CONCURRENCY,
        async (pkg) => {
          const preview = await deployPreview(pkg, previewName, wrangler.command);
          assertNoPreviewUrl(pkg, preview.url);
          return [pkg.name, preview.id];
        });
    const gatekeeperIds = Object.fromEntries(gatekeeperPreviews);

    const fakePreview = await deployPreview(
        codexFakeUpstream, previewName, wrangler.command);
    assertNoPreviewUrl(codexFakeUpstream, fakePreview.url);
    patchPreviewServiceBindings(codexRelay, {
      [codexFakeUpstream.name]: fakePreview.id,
    });
    await uploadPreviewSecrets(codexRelay, wrangler.command, relaySecrets);
    const relayPreview = await deployPreview(codexRelay, previewName, wrangler.command);
    assertNoPreviewUrl(codexRelay, relayPreview.url);

    patchPreviewServiceBindings(backend, gatekeeperIds);
    patchPreviewServiceBindings(backend, { [codexRelay.name]: relayPreview.id });
    patchPreviewServiceBindings(router, gatekeeperIds);
    // Before the backend's preview, not after: a preview inherits the Previews settings that exist
    // when it is created.
    await uploadPreviewSecrets(backend, wrangler.command, secrets);
    const backendPreview = await deployPreview(backend, previewName, wrangler.command);
    assertNoPreviewUrl(backend, backendPreview.url);

    patchPreviewServiceBindings(router, {
      [backend.name]: backendPreview.id,
    });
    const routerPreview = await deployPreview(router, previewName, wrangler.command);
    assertRouterPreviewUrl(router, previewName, workersDevHost, routerPreview.url);

    console.log(`\nPreview "${previewName}" is live at ${routerPreview.url}`);
    writePreviewComment(routerPreview.url, routerPreview.slug,
        readConfig(router.dir).account_id);
  } finally {
    wrangler.cleanup();
  }
}

async function remove({ dryRun }: { dryRun: boolean }): Promise<void> {
  const previewName = resolvePreviewName();
  const deployMode = resolvePreviewDeployMode();
  // Regenerate rather than assume: `delete` runs in its own CI job with a fresh checkout, and
  // wrangler needs a config to know which worker and account the preview belongs to.
  const { packages, configs } = generatePreviewConfigs({ previewName, deployMode });
  const { gatekeepers, codexFakeUpstream, codexRelay, backend, router } = tiers(packages);

  if (dryRun) {
    console.log(`\ndry-run: would delete ${deployMode === "named" ? "named fallback" : "preview"} ` +
        `"${previewName}" for ` +
        [router, backend, codexRelay, codexFakeUpstream, ...gatekeepers]
            .map((pkg) => readConfig(pkg.dir).name).join(", "));
    if (deployMode === "named") {
      console.log("  exact auto-provisioned resources: " +
          namedAutoResources(configs).map(({ name }) => name).join(", "));
    }
    return;
  }

  const wrangler = preparePreviewWrangler(deployMode);
  try {
    await wrangler.ready;
    if (deployMode === "named") {
      // Resolve auth before deleting a Worker: a missing OAuth session leaves the complete instance
      // intact instead of deleting compute first and discovering that its R2 data cannot be cleaned.
      const cleanupToken = await namedCleanupBearerToken(router, wrangler.command);
      await deleteNamedWorkers(packages, wrangler.command);
      await cleanupNamedResources(
          router, wrangler.command, previewName, namedAutoResources(configs), cleanupToken);
    } else {
      await deletePreviewFrom(packages, previewName, wrangler.command);
    }
  } finally {
    wrangler.cleanup();
  }
}

// --- sweep -------------------------------------------------------------------------------
//
// GitHub has no equivalent of GitLab's `environment.auto_stop_in`, and a PR that is force-closed,
// or whose cleanup job failed, leaves an instance behind — with an auto-provisioned KV pair and
// R2 bucket per preview, that leaks. This is the replacement, run nightly.

const PREVIEW_MAX_AGE_DAYS = 7;

async function cloudflareApi(
  path: string,
  { method = "GET", bearerToken = process.env.CLOUDFLARE_API_TOKEN }: {
    method?: "GET" | "DELETE";
    bearerToken?: string;
  } = {},
): Promise<unknown> {
  if (!bearerToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required for preview API operations");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  const body = await response.json().catch(() => ({})) as
      { success?: boolean; errors?: unknown; result?: unknown };
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare API ${method} ${path} failed with ${response.status}: ` +
        JSON.stringify(body.errors ?? body));
  }
  return body.result;
}

async function emptyNamedR2Bucket(
  accountId: string,
  bucketName: string,
  bearerToken: string,
): Promise<void> {
  const bucketPath = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`;
  // The REST object API accepts the same API token as the deployment. Re-read page one after each
  // batch instead of trusting a cursor whose collection is being modified underneath it. The
  // Worker has already been deleted, so no legitimate writer remains and the loop converges.
  for (;;) {
    let listed: unknown;
    try {
      listed = await cloudflareApi(
          `${bucketPath}/objects?limit=1000`, { bearerToken });
    } catch (error) {
      if (/not found|does not exist|10006|10007/i.test(describe(error))) return;
      throw error;
    }
    const objects = Array.isArray(listed)
      ? listed
      : (listed && typeof listed === "object" && Array.isArray((listed as { objects?: unknown }).objects)
          ? (listed as { objects: unknown[] }).objects : undefined);
    if (!objects) {
      throw new Error(`Expected an object list for exact named bucket ${bucketName}, got ` +
          `${JSON.stringify(listed)?.slice(0, 200)}`);
    }
    if (objects.length === 0) return;
    await mapWithConcurrency(objects, GATEKEEPER_CONCURRENCY, async (object) => {
      const key = object && typeof object === "object" && "key" in object
        ? (object as { key?: unknown }).key : undefined;
      if (typeof key !== "string") {
        throw new Error(`R2 listed an object without a string key in ${bucketName}`);
      }
      await cloudflareApi(`${bucketPath}/objects/${encodeURIComponent(key)}`,
          { method: "DELETE", bearerToken });
    });
  }
}

/** Delete only the exact resource names derived from this named instance's generated configs. */
async function cleanupNamedResources(
  commandWorker: DeployablePackage,
  wranglerCommand: string,
  previewName: string,
  resources: readonly NamedAutoResource[],
  bearerToken: string,
): Promise<void> {
  // Validate the complete set before the first irreversible request, not lazily while deleting.
  assertNamedResourceScope(previewName, resources);
  const accountId = readConfig(commandWorker.dir).account_id;
  if (!accountId) throw new Error("named resource cleanup needs the generated account_id");
  const failures: unknown[] = [];
  for (const resource of resources) {
    try {
      if (resource.kind === "r2") {
        await emptyNamedR2Bucket(accountId, resource.name, bearerToken);
      }
      const args = resource.kind === "kv"
        ? ["kv", "namespace", "delete", resource.name, "-c", STAGING_CONFIG_NAME, "-y"]
        : resource.kind === "r2"
          ? ["r2", "bucket", "delete", resource.name, "-c", STAGING_CONFIG_NAME]
          : ["d1", "delete", resource.name, "-c", STAGING_CONFIG_NAME, "-y"];
      console.log(`deleting exact named ${resource.kind} resource: ${resource.name}`);
      const result = await runWrangler(commandWorker, wranglerCommand, args);
      writeCommandOutput(commandWorker, result);
      if (result.status === 0) continue;
      if (/not found|does not exist|10006|10007/i.test(`${result.stdout}\n${result.stderr}`)) {
        console.warn(`Named ${resource.kind} resource ${resource.name} did not exist; continuing.`);
        continue;
      }
      throw new Error(`failed to delete exact named ${resource.kind} resource ${resource.name} ` +
          `(exit ${result.status})`);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const failure of failures.slice(1)) {
    console.error(`Additional named resource cleanup failure: ${describe(failure)}`);
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * One pull request's state.
 *
 * A 404 is an answer rather than a failure: the number was read out of a live preview's name, so a
 * pull request that does not exist means the preview outlived it. Anything else that goes wrong is
 * `unknown` — a transient 403 (GitHub's secondary rate limit) or 5xx must never be what deletes a
 * preview an open pull request is still using, so those fall back to being judged on age alone.
 */
async function fetchPullRequestState(repo: string, number: number): Promise<PullRequestState> {
  const path = `/repos/${repo}/pulls/${number}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cloudflare-os-preview-sweep",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const response = await fetch(`https://api.github.com${path}`, { headers });
    if (response.status === 404) return "missing";
    if (!response.ok) throw new Error(`GitHub API GET ${path} failed with ${response.status}`);
    const { state } = await response.json() as FetchedPullRequest;
    if (state === "open" || state === "closed") return state;
    throw new Error(`GitHub API GET ${path} reported the state ${JSON.stringify(state)}`);
  } catch (error) {
    console.warn(`${describe(error)}; pull request ${number}'s preview is swept on age alone.`);
    return "unknown";
  }
}

/**
 * Every listed preview's pull request state, keyed by preview name.
 *
 * The number is part of the name ({@link previewPullRequestNumber}), so this is one request per
 * *distinct* pull request — no walk of the repository's recent ones, and no bound on how old a pull
 * request the sweep can still recognize.
 */
async function pullRequestStates(
  repo: string,
  previewNames: readonly string[],
): Promise<Map<string, PullRequestState>> {
  const numbers = [...new Set(previewNames
      .map((name) => previewPullRequestNumber(name))
      .filter((value): value is number => value !== undefined))];
  const states = await mapWithConcurrency(numbers, API_CONCURRENCY,
      (number) => fetchPullRequestState(repo, number));
  const byNumber = new Map(numbers.map((number, index) => [number, states[index]]));

  return new Map(previewNames.map((name) => {
    // A preview with no number in its name was deployed from a local checkout, and is something
    // this sweep can say nothing about: age alone decides it.
    const number = previewPullRequestNumber(name);
    return [name, (number === undefined ? undefined : byNumber.get(number)) ?? "unknown"];
  }));
}

function daysSince(timestamp: string): number {
  return (Date.now() - Date.parse(timestamp)) / 86_400_000;
}

function ageInDays(preview: ListedPreview): number | null {
  const stamp = preview.created_on ?? preview.created_at ?? preview.modified_on;
  const age = stamp ? daysSince(stamp) : NaN;
  return Number.isNaN(age) ? null : age;
}

/* Every preview live on any of this checkout's workers, as `name -> the workers carrying it` */
async function listPreviewsByName(
  accountId: string | undefined,
  packages: readonly DeployablePackage[],
): Promise<Map<string, IndexedPreview>> {
  const lists = await mapWithConcurrency(packages, API_CONCURRENCY, async (pkg) => {
    let previews: unknown;
    try {
      previews = await cloudflareApi(
          `/accounts/${accountId}/workers/workers/${pkg.name}/previews`);
    } catch (error) {
      // A worker whose baseline has never been deployed on this account — one added since the last
      // preview ran — carries no previews rather than being a failure.
      if (!isMissingWorkerError(describe(error))) throw error;
      console.warn(`${pkg.name} does not exist on this account yet; it holds no previews.`);
      previews = [];
    }
    if (!Array.isArray(previews)) {
      throw new Error(`Expected a list of previews for ${pkg.name}, got ` +
          `${JSON.stringify(previews)?.slice(0, 200)}`);
    }
    return previews as ListedPreview[];
  });

  const index = new Map<string, IndexedPreview>();
  for (const [position, previews] of lists.entries()) {
    for (const preview of previews) {
      const age = ageInDays(preview);
      const found = index.get(preview.name);
      if (!found) {
        index.set(preview.name, { workers: [packages[position]], age });
        continue;
      }
      found.workers.push(packages[position]);
      // The newest copy decides the age, so a preview is only old enough to sweep once every
      // worker's copy of it is.
      if (age !== null && (found.age === null || age < found.age)) found.age = age;
    }
  }
  return index;
}

// Why this preview should go, or an empty list to keep it.
function staleReasons(preview: IndexedPreview, state: PullRequestState): string[] {
  const reasons: string[] = [];
  if (preview.age !== null && preview.age > PREVIEW_MAX_AGE_DAYS) {
    reasons.push(`${preview.age.toFixed(1)} days old`);
  }

  // `unknown` — a preview deployed by hand from a local checkout, or a GitHub request that failed —
  // contributes no reason of its own, leaving age to decide.
  if (state === "closed") reasons.push("its pull request is closed");
  else if (state === "missing") reasons.push("it names no pull request in this repository");
  return reasons;
}

async function sweep({ dryRun }: { dryRun: boolean }): Promise<void> {
  if (resolvePreviewDeployMode() === "named") {
    throw new Error("PREVIEW_DEPLOY_MODE=named does not support account-wide sweep: normal " +
        "Workers have no Worker Preview metadata. Run preview:delete with the original " +
        "PREVIEW_NAME/PREVIEW_PR_NUMBER so cleanup stays exact-prefix scoped.");
  }
  const { packages } = generatePreviewConfigs();
  const { router } = tiers(packages);
  const accountId = readConfig(router.dir).account_id;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.warn("GITHUB_REPOSITORY is unset: sweeping on age only, not on PR state.");
  }

  const index = await listPreviewsByName(accountId, packages);
  console.log(`\n${index.size} preview(s) across ${packages.length} worker(s).`);
  const states = repo
      ? await pullRequestStates(repo, [...index.keys()])
      : new Map<string, PullRequestState>();

  const stale: { name: string; workers: DeployablePackage[]; reasons: string[] }[] = [];
  for (const [name, preview] of index) {
    const reasons = staleReasons(preview, states.get(name) ?? "unknown");
    if (reasons.length > 0) stale.push({ name, workers: preview.workers, reasons });
    else console.log(`  keeping ${name} (on ${preview.workers.map((pkg) => pkg.name).join(", ")})`);
  }

  if (stale.length === 0) {
    console.log("Nothing to sweep.");
    return;
  }
  for (const { name, workers, reasons } of stale) {
    console.log(`  ${dryRun ? "dry-run: would delete" : "deleting"} ${name} (${reasons.join(", ")}) ` +
        `from ${workers.map((pkg) => pkg.name).join(", ")}`);
  }
  if (dryRun) return;

  const wrangler = preparePreviewWrangler();
  const failed: string[] = [];
  try {
    await wrangler.ready;
    // Delete is keyed on `--name` alone; the generated configs only supply the worker and account
    // to target, so one set of them serves every preview name being swept.
    for (const { name, workers } of stale) {
      try {
        await deletePreviewFrom(workers, name, wrangler.command);
      } catch (error) {
        // Each preview is independent, and one left behind is a KV pair and an R2 bucket leaked
        // until tomorrow night, so the rest still go.
        failed.push(name);
        console.error(`Failed to delete ${name}: ${describe(error)}`);
      }
    }
  } finally {
    wrangler.cleanup();
  }
  console.log(`\nSwept ${stale.length - failed.length} of ${stale.length} preview(s).`);
  if (failed.length > 0) throw new Error(`failed to delete ${failed.join(", ")}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(join(ROOT, "packages", "workshop-backend", "wrangler.jsonc"))) {
    throw new Error("run this from a full checkout: packages/workshop-backend is missing");
  }

  if (args.command === "config") generatePreviewConfigs();
  else if (args.command === "deploy") await deploy(args);
  else if (args.command === "delete") await remove(args);
  else await sweep(args);
} catch (error) {
  console.error(describe(error));
  process.exit(1);
}
