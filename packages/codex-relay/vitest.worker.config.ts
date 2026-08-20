import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // `test:run` prebuilds this entrypoint so coverage instruments the exact validated source
      // Workerd executes instead of relying on the decorator transform's lossy source-map remap.
      main: "./.wrangler/validate/__tests__/worker.ts",
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
    coverage: {
      enabled: true,
      provider: "istanbul",
      include: [
        ".wrangler/validate/src/security-critical.ts",
        ".wrangler/validate/src/vault.ts",
      ],
      reporter: [["text", { skipFull: false }]],
      reportsDirectory: "coverage/workerd",
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
