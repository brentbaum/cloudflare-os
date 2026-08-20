import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    coverage: {
      enabled: true,
      provider: "istanbul",
      // Security decisions are extracted into a production-used pure module so the branch gate is
      // exhaustive without counting Workerd/RPC defensive machinery as uncovered policy logic.
      include: ["src/security-critical.ts"],
      reporter: ["text"],
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
