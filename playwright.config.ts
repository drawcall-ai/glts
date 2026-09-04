import { defineConfig } from "@playwright/test";

const port = process.env.GLTS_E2E_PORT ?? "5173";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./examples/viewer/e2e",
  outputDir: ".artifacts/playwright",
  timeout: 60_000,
  expect: {
    timeout: 20_000
  },
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 }
  },
  webServer: {
    command: `pnpm --filter @drawcall/glts-example-viewer dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000
  }
});
