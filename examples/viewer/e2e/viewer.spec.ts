import { expect, test } from "@playwright/test";

import { fulfillGLTS } from "./routes.js";

const localScene = `
  import * as THREE from "three"
  import { isPreview, onDispose, scene } from "@drawcall/glts"
  const geometry = new THREE.BoxGeometry()
  const material = new THREE.MeshBasicMaterial({ color: "#ff8844" })
  scene.add(new THREE.Mesh(geometry, material))
  if (isPreview) scene.background = new THREE.Color("#181018")
  onDispose(() => {
    geometry.dispose()
    material.dispose()
  })
`;

test("renders the viewer at fractional device pixel ratios", async ({ browser }) => {
  const context = await browser.newContext({
    deviceScaleFactor: 1.5,
    viewport: { height: 777, width: 1001 }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto("/");
    await expect(page.locator("#status")).toHaveText(
      "Vintage Racecar · Multi-file composition"
    );
    await page.waitForTimeout(1_000);
    expect(errors).toEqual([]);
    await expect(page.locator("#stats")).toContainText("draw calls");
  } finally {
    await context.close();
  }
});

test("renders the bundled racecar", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.locator("#status")).toHaveText(
    "Vintage Racecar · Multi-file composition"
  );
  await page.waitForTimeout(800);
  await page.screenshot({
    path: testInfo.outputPath("vintage-racecar.png"),
    scale: "css"
  });
  expect(errors).toEqual([]);
});

test("composes the racecar from its own nested GLTS files", async ({ page }) => {
  const loaded = new Set<string>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    const prefix = "/assets/showcases/vintage-racecar/";
    if (path.startsWith(prefix)) loaded.add(path.slice(prefix.length));
  });

  await page.goto("/");
  await expect(page.locator("#status")).toHaveText(
    "Vintage Racecar · Multi-file composition"
  );
  await expect(page.locator("#stats")).toContainText("draw calls");
  expect([...loaded].sort()).toEqual([
    "body.glts",
    "chassis.glts",
    "cockpit.glts",
    "index.glts",
    "paddock.glts",
    "wheel.glts"
  ]);
});

test("opens a dropped local GLTS file", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText(
    "Vintage Racecar · Multi-file composition"
  );

  await page.evaluate((source) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([source], "local-cube.glts", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }));
    if (!document.querySelector("#viewer")?.hasAttribute("data-dragging")) {
      throw new Error("The viewer did not enter its drop state");
    }
    window.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }));
  }, localScene);

  await expect(page.locator("#status")).toHaveText("local-cube.glts · local file");
  await expect(page.locator('[data-showcase][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator("#viewer")).not.toHaveAttribute("data-dragging", "");
});

test("keeps the current scene when a local file fails", async ({ page }) => {
  await page.goto("/");
  const racecar = page.getByRole("button", { name: /Vintage Racecar/ });
  await expect(racecar).toHaveAttribute("aria-pressed", "true");

  await page.locator("#file-input").setInputFiles({
    name: "broken.glts",
    mimeType: "text/plain",
    buffer: Buffer.from('throw new Error("local failure")')
  });

  await expect(page.locator("#status")).toContainText("Couldn’t open broken.glts");
  await expect(racecar).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("canvas")).toBeVisible();
});

test("reports an initial showcase failure in the page", async ({ page }) => {
  await page.route("**/assets/showcases/vintage-racecar/index.glts", (route) =>
    fulfillGLTS(route, 'throw new Error("initial showcase failed")')
  );

  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "Couldn’t open Vintage Racecar"
  );
  await expect(page.locator("#status-dot")).toHaveAttribute("data-state", "error");
});

test("keeps viewer controls visible in a compact mobile viewport", async ({ page }) => {
  await page.setViewportSize({ height: 568, width: 320 });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Vintage Racecar");

  for (const locator of [
    page.getByText("Drop a .glts anywhere"),
    page.getByRole("button", { name: /Vintage Racecar/ }),
    page.locator("#status"),
    page.locator("#stats")
  ]) {
    await expect(locator).toBeVisible();
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds) {
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(568);
    }
  }
});
