import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/codex-sidecar.worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: [
          "experimental",
          "nodejs_compat",
          "enable_request_signal",
          "enable_abortsignal_rpc",
        ],
        bindings: {
          ADMINS: JSON.stringify(["codexadmin"]),
          CODEX_SUBSCRIPTION_ENABLED: "true",
          CODEX_WRAPPING_KEY_CURRENT: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
          ENABLE_CLOUDFLARE_LIMITS: "true",
          DAILY_LLM_CALL_LIMIT: "1",
          CF_AI_GATEWAY: "platform-gateway-must-not-cross",
          CF_AI_GATEWAY_ACCOUNT_ID: "platform-account-must-not-cross",
          CF_AI_GATEWAY_API_TOKEN: "platform-token-must-not-cross",
        },
        durableObjects: {
          // The production worker reaches these namespaces through ctx.exports. Miniflare needs
          // them declared so its Vitest wrapper recognizes the named exports as DO classes.
          AdminSettings: { className: "AdminSettings", useSQLite: true },
          OverseerDurableObject: { className: "OverseerDurableObject", useSQLite: true },
          PendingLogin: { className: "PendingLogin", useSQLite: true },
          UserDurableObject: { className: "UserDurableObject", useSQLite: true },
          CODEX_AUTH: { className: "CodexAuth", useSQLite: true },
        },
        kvNamespaces: ["BLUEPRINTS"],
        r2Buckets: ["BLUEPRINT_CONTENT"],
        serviceBindings: {
          CODEX_RELAY: { name: kCurrentWorker, entrypoint: "CrossPackageCodexRelay" },
          CODEX_UPSTREAM: { name: kCurrentWorker, entrypoint: "CrossPackageCodexUpstream" },
        },
      },
    }),
  ],
  test: {
    // `.spec.ts` keeps this cross-package pool out of the backend's default `*.test.ts` suite.
    include: ["__tests__/codex-sidecar.integration.spec.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
    testTimeout: 30_000,
    // vitest-pool independently reports the pending RPC read cancellation after Pi handles it.
    // Production has no suppression. Keep this dedicated-suite exception pinned to Pi 0.83's
    // parseSSE frame; its truthful dist source map presents the runtime JS frame as the TS source.
    onUnhandledError(error) {
      if (typeof error !== "object" || error === null) return true;
      const message = "message" in error ? error.message : undefined;
      const stack = "stack" in error ? error.stack : undefined;
      const isPinnedPiParseSseCancellation =
        message === "Stream was cancelled." &&
        typeof stack === "string" &&
        /at parseSSE \([^\n)]*\/@earendil-works\+pi-ai@0\.83\.0_patch_hash=[^/\n]+\/node_modules\/@earendil-works\/pi-ai\/src\/api\/openai-codex-responses\.ts:\d+:\d+\)/.test(
          stack,
        );
      return !isPinnedPiParseSseCancellation;
    },
  },
});
