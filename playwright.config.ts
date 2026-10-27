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
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: [
        "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
        // Headless Linux needs software rendering for both WebGPU and the compositor.
        ...(process.platform === "linux" ? [
          "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-vulkan=swiftshader",
          "--use-webgpu-adapter=swiftshader", "--disable-vulkan-surface"
        ] : [])
      ]
    }
  },
  webServer: {
    // --force: Vite's prebundle cache would otherwise keep serving the GLTS build it first saw.
    command: `pnpm --filter @drawcall/glts-example-viewer dev --host 127.0.0.1 --port ${port} --strictPort --force`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
