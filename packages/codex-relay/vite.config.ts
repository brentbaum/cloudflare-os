import vitestTaskViteConfig from "../../scripts/vitest-task-vite-config.js";

export default vitestTaskViteConfig([
  "vitest run",
  "vitest run -c vitest.worker.config.ts",
]);
