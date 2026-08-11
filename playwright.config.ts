import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./examples/basic/e2e",
  outputDir: ".artifacts/playwright",
  timeout: 60_000,
  expect: {
    timeout: 20_000
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 }
  },
  webServer: {
    command: "pnpm --filter @drawcall/glts-example-basic dev --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30_000
  }
});
