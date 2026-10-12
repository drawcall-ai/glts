import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Vite builds and TypeScript checks take seconds on slow machines.
    testTimeout: 30_000
  }
});
