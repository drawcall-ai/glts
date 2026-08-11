import { expect, test } from "@playwright/test";

test("loads TypeScript assets without external network access", async ({ page }) => {
  await page.route("**/assets/offline.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"

      export default class OfflineAsset extends THREE.Group {
        constructor() {
          super()
          this.name = "offline"
        }
      }
    `,
    contentType: "text/plain"
  }));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5173(?:\/|$))/, (route) => {
    return route.abort("internetdisconnected");
  });

  await page.goto("/test-harness.html");
  const name = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/offline.glts");
    const objectName = asset.scene.children.at(0)?.name;
    asset.dispose();
    loader.dispose();
    return objectName;
  });

  expect(name).toBe("offline");
});

test("preserves unused value imports because they can have side effects", async ({ page }) => {
  await page.route("**/assets/import-semantics.glts", (route) => route.fulfill({
    body: `
      import { marker } from "https://fixtures.glts.test/side-effect.js"
      import * as THREE from "three"

      export default class ImportSemantics extends THREE.Group {}
    `,
    contentType: "text/plain"
  }));
  await page.route("https://fixtures.glts.test/side-effect.js", (route) => route.fulfill({
    body: `
      globalThis.__gltsSideEffect = (globalThis.__gltsSideEffect ?? 0) + 1
      export const marker = true
    `,
    contentType: "text/javascript"
  }));

  await page.goto("/test-harness.html");
  const sideEffects = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/import-semantics.glts");
    const count = Reflect.get(globalThis, "__gltsSideEffect");
    asset.dispose();
    loader.dispose();
    return count;
  });

  expect(sideEffects).toBe(1);
});

test("executes erased and runtime TypeScript semantics together", async ({ page }) => {
  await page.route("**/assets/typescript-semantics.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import type { ColorRepresentation } from "three"

      enum Axis { X = "x" }

      class Dimensions {
        constructor(readonly width: number, readonly height: number) {}
      }

      function identity<T>(value: T): T {
        return value
      }

      const appearance = {
        color: "#ff5c35" as ColorRepresentation,
      } satisfies THREE.MeshStandardMaterialParameters

      export default class TypeScriptSemantics extends THREE.Group {
        readonly #dimensions = new Dimensions(3, 4)

        constructor() {
          super()
          this.name = identity(Axis.X)
          this.userData.area = this.#dimensions.width * this.#dimensions.height
          this.userData.color = appearance.color
          this.userData.sourceURL = import.meta.url
        }
      }
    `,
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/typescript-semantics.glts");
    const object = asset.scene.children.at(0);
    if (!object) {
      throw new Error("Compiled asset did not construct an Object3D");
    }

    const snapshot = {
      area: Reflect.get(object.userData, "area"),
      color: Reflect.get(object.userData, "color"),
      name: object.name,
      sourceURL: Reflect.get(object.userData, "sourceURL")
    };
    asset.dispose();
    loader.dispose();
    return snapshot;
  });

  expect(result).toEqual({
    area: 12,
    color: "#ff5c35",
    name: "x",
    sourceURL: "http://127.0.0.1:5173/assets/typescript-semantics.glts"
  });
});

test("reports the asset URL and source position for TypeScript syntax errors", async ({ page }) => {
  await page.route("**/assets/broken-typescript.glts", (route) => route.fulfill({
    body: [
      "import * as THREE from \"three\"",
      "",
      "export default class Broken extends"
    ].join("\n"),
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const diagnostic = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();

    try {
      await loader.loadAsync("/assets/broken-typescript.glts");
      throw new Error("Expected invalid TypeScript to fail");
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      return {
        causeMessage: cause instanceof Error ? cause.message : String(cause),
        causeName: cause instanceof Error ? cause.name : undefined,
        location: cause && typeof cause === "object" ? Reflect.get(cause, "loc") : undefined,
        message: error instanceof Error ? error.message : String(error),
        phase: error && typeof error === "object" ? Reflect.get(error, "phase") : undefined,
        url: error && typeof error === "object" ? Reflect.get(error, "url") : undefined
      };
    } finally {
      loader.dispose();
    }
  });

  expect(diagnostic).toEqual({
    causeMessage: "Unexpected token, expected \"{\" (3:29)",
    causeName: "SyntaxError",
    location: { column: 29, line: 3 },
    message: [
      "[GLTS:transform] Unable to compile TypeScript asset",
      "URL: http://127.0.0.1:5173/assets/broken-typescript.glts"
    ].join("\n"),
    phase: "transform",
    url: "http://127.0.0.1:5173/assets/broken-typescript.glts"
  });
});

test("loads and explicitly reloads procedural assets", async ({ page }, testInfo) => {
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

  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    intro: document.querySelector(".intro")?.getBoundingClientRect().toJSON(),
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    width: window.innerWidth
  }));
  expect(viewport.scrollWidth).toBe(viewport.width);
  expect(viewport.scrollHeight).toBe(viewport.height);
  expect(viewport.intro?.bottom).toBeLessThanOrEqual(viewport.height);

  await page.screenshot({ path: testInfo.outputPath("desktop.png"), scale: "css" });
  expect(consoleErrors).toEqual([]);
});

test("keeps the scene visible when a reload fails", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Asset loaded");

  await page.route("**/assets/branch.glts", async (route) => {
    await route.fulfill({
      body: "export default class Broken extends",
      contentType: "text/plain",
      status: 200
    });
  });

  await page.getByRole("button", { name: "Reload branches" }).click();
  await expect(page.locator("#status")).toContainText("[GLTS:transform]");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload branches" })).toBeEnabled();
});

test("presents a usable mobile layout", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();

  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Asset loaded");
  await expect(page.getByRole("button", { name: "Reload tree" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload branches" })).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();

  const width = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth
  }));
  expect(width.scroll).toBe(width.client);

  await page.screenshot({ path: testInfo.outputPath("mobile.png"), scale: "css" });
  await context.close();
});
