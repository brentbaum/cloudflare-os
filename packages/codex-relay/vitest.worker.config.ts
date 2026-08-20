import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        durableObjects: {
          CODEX_AUTH: { className: "CodexAuth", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
