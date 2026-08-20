import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    coverage: {
      enabled: true,
      provider: "istanbul",
      // Pure provider parsing and request policy are exhaustive here; the durable vault is
      // separately instrumented on the exact capnweb-validated source in the Workerd config.
      include: ["src/oauth.ts", "src/policy.ts", "src/security-critical.ts"],
      reporter: [["text", { skipFull: false }]],
      reportsDirectory: "coverage/node",
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
