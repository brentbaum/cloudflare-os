import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_compat", "enable_request_signal", "enable_abortsignal_rpc"],
        bindings: {
          CODEX_WRAPPING_KEY_CURRENT: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
        },
        durableObjects: {
          CODEX_AUTH: { className: "CodexAuth", useSQLite: true },
        },
        serviceBindings: {
          CODEX_RELAY: { name: kCurrentWorker, entrypoint: "CodexRelay" },
          CODEX_UPSTREAM: { name: kCurrentWorker, entrypoint: "TestUpstream" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
