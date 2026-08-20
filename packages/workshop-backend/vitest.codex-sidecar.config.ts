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
    // vitest-pool reports the pending RPC body read's expected cancellation even though the
    // cancellation is handled. This dedicated test still proves bounded upstream cancellation,
    // exactly one body cancel, an un-aborted post-header request signal, and Pi's aborted result.
    onUnhandledError(error) {
      return !(
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        error.message === "Stream was cancelled."
      );
    },
  },
});
