import { expect, test } from "@playwright/test";

import { fulfillGLTS } from "./routes.js";

test("loads and reloads the example", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Asset loaded");
  await expect(page.locator("canvas")).toBeVisible();

  await page.getByRole("button", { name: "Reload branches" }).click();
  await expect(page.locator("#status")).toHaveText("Reloaded /assets/branch.glts");

  await page.getByRole("button", { name: "Reload tree" }).click();
  await expect(page.locator("#status")).toHaveText("Reloaded /assets/tree.glts");

  await page.screenshot({ path: testInfo.outputPath("desktop.png"), scale: "css" });
  expect(consoleErrors).toEqual([]);
});

test("keeps the current scene when reload execution fails", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Asset loaded");

  await page.route("**/assets/tree.glts", (route) => fulfillGLTS(route, `
    import { scene } from "@drawcall/glts"
    scene.name = "partial replacement"
    throw new Error("replacement failed")
  `));

  await page.getByRole("button", { name: "Reload tree" }).click();
  await expect(page.locator("#status")).toContainText("[GLTS:evaluate]");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload tree" })).toBeEnabled();
});

test("reports an initial load failure in the page", async ({ page }) => {
  await page.route("**/assets/tree.glts", (route) => fulfillGLTS(route, `
    throw new Error("initial tree failed")
  `));

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Unable to execute GLTS script");
  await expect(page.locator("#status-dot")).toHaveAttribute("data-state", "error");
});

test("keeps every control visible in a compact mobile viewport", async ({ page }) => {
  await page.setViewportSize({ height: 568, width: 320 });
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Asset loaded");

  for (const locator of [
    page.getByRole("button", { name: "Reload tree" }),
    page.getByRole("button", { name: "Reload branches" }),
    page.locator("#status"),
    page.locator("#stats"),
    page.locator(".hint")
  ]) {
    await expect(locator).toBeVisible();
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds) {
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(568);
    }
  }
});
