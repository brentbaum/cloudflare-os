import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    coverage: {
      enabled: true,
      provider: "istanbul",
      include: ["src/oauth.ts", "src/policy.ts"],
      reporter: ["text"],
      reportsDirectory: "coverage/node",
      thresholds: {
        statements: 81,
        branches: 72,
        functions: 97,
        lines: 85,
      },
    },
  },
});
