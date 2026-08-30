import { expect, test } from "@playwright/test";

import {
  assetSource,
  fulfillGLTS,
  routeGLTS,
  routeGLTSRevisions
} from "./routes.js";

test("loads TypeScript assets without external network access", async ({ page }) => {
  await routeGLTS(page, "**/assets/offline.glts", `
      import * as THREE from "three"

      export default class OfflineAsset extends THREE.Group {
        constructor() {
          super()
          this.name = "offline"
        }
      }
    `);
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

test("reports only assets reachable from live roots after a root reload", async ({ page }) => {
  const rootSources = [
    assetSource("first root", "./reachable-child.glts"),
    assetSource("second root")
  ];
  const rootRevisions = await routeGLTSRevisions(
    page,
    "**/assets/reachable-root.glts",
    rootSources
  );
  await routeGLTS(page, "**/assets/reachable-child.glts", assetSource("child"));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/reachable-root.glts");
    const stableRoot = asset.scene;
    const beforeReload = {
      child: loader.has("/assets/reachable-child.glts"),
      root: loader.has("/assets/reachable-root.glts")
    };

    await loader.reload("/assets/reachable-root.glts");
    const afterReload = {
      child: loader.has("/assets/reachable-child.glts"),
      root: loader.has("/assets/reachable-root.glts"),
      stableRoot: asset.scene === stableRoot
    };
    loader.dispose();
    return { afterReload, beforeReload };
  });

  expect(rootRevisions.requests).toBe(2);
  expect(result).toEqual({
    afterReload: { child: false, root: true, stableRoot: true },
    beforeReload: { child: true, root: true }
  });
});

test("updates reachability when replacement commits before old disposal fails", async ({ page }) => {
  const rootSources = [
    `
      import * as THREE from "three"
      import Child from "./failed-disposal-child.glts"
      export const previewCamera = new THREE.PerspectiveCamera()
      export default class Asset extends THREE.Group {
        constructor() {
          super()
          this.name = "old"
          this.add(new Child())
        }
        dispose() {
          throw new Error("old disposal failed")
        }
      }
    `,
    `
      import * as THREE from "three"
      export const previewCamera = new THREE.OrthographicCamera()
      export default class Asset extends THREE.Group {
        constructor() {
          super()
          this.name = "new"
        }
      }
    `
  ];
  const rootRevisions = await routeGLTSRevisions(
    page,
    "**/assets/failed-disposal-root.glts",
    rootSources
  );
  await routeGLTS(page, "**/assets/failed-disposal-child.glts", assetSource("child"));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/failed-disposal-root.glts");
    let errorPhase: unknown;
    try {
      await loader.reload("/assets/failed-disposal-root.glts");
    } catch (error) {
      errorPhase = window.readErrorField(error, "phase");
    }

    const snapshot = {
      child: loader.has("/assets/failed-disposal-child.glts"),
      errorPhase,
      name: asset.scene.children.at(0)?.name,
      previewCamera: asset.previewCamera?.type,
      root: loader.has("/assets/failed-disposal-root.glts")
    };
    loader.dispose();
    return snapshot;
  });

  expect(rootRevisions.requests).toBe(2);
  expect(result).toEqual({
    child: false,
    errorPhase: "dispose",
    name: "new",
    previewCamera: "PerspectiveCamera",
    root: true
  });
});

test("keeps old reachability when replacement construction fails", async ({ page }) => {
  const rootSources = [
    assetSource("old root", "./preserved-child.glts"),
    `
      import * as THREE from "three"
      import Child from "./rejected-child.glts"
      export default class Asset extends THREE.Group {
        constructor() {
          super()
          this.add(new Child())
          throw new Error("replacement rejected")
        }
      }
    `
  ];
  const rootRevisions = await routeGLTSRevisions(
    page,
    "**/assets/rejected-root.glts",
    rootSources
  );
  await page.route(/.*\/assets\/(?:preserved|rejected)-child\.glts/, (route) =>
    fulfillGLTS(route, assetSource("child"))
  );

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/rejected-root.glts");
    const stableRoot = asset.scene;
    let rejected = false;
    try {
      await loader.reload("/assets/rejected-root.glts");
    } catch {
      rejected = true;
    }

    const snapshot = {
      name: asset.scene.children.at(0)?.name,
      preservedChild: loader.has("/assets/preserved-child.glts"),
      rejected,
      rejectedChild: loader.has("/assets/rejected-child.glts"),
      root: loader.has("/assets/rejected-root.glts"),
      stableRoot: asset.scene === stableRoot
    };
    loader.dispose();
    return snapshot;
  });

  expect(rootRevisions.requests).toBe(2);
  expect(result).toEqual({
    name: "old root",
    preservedChild: true,
    rejected: true,
    rejectedChild: false,
    root: true,
    stableRoot: true
  });
});

test("keeps a shared child reachable until its last root releases it", async ({ page }) => {
  const firstRootSources = [
    assetSource("first root", "./shared-child.glts"),
    assetSource("first root reloaded")
  ];
  const firstRootRevisions = await routeGLTSRevisions(
    page,
    "**/assets/first-root.glts",
    firstRootSources
  );
  await routeGLTS(
    page,
    "**/assets/second-root.glts",
    assetSource("second root", "./shared-child.glts")
  );
  await routeGLTS(page, "**/assets/shared-child.glts", assetSource("shared child"));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    await loader.loadAsync("/assets/first-root.glts");
    const second = await loader.loadAsync("/assets/second-root.glts");
    const initiallyShared = loader.has("/assets/shared-child.glts");
    await loader.reload("/assets/first-root.glts");
    const sharedAfterFirstReload = loader.has("/assets/shared-child.glts");
    second.dispose();
    const afterSecondDispose = {
      child: loader.has("/assets/shared-child.glts"),
      firstRoot: loader.has("/assets/first-root.glts"),
      secondRoot: loader.has("/assets/second-root.glts")
    };
    loader.dispose();
    return { afterSecondDispose, initiallyShared, sharedAfterFirstReload };
  });

  expect(firstRootRevisions.requests).toBe(2);
  expect(result).toEqual({
    afterSecondDispose: {
      child: false,
      firstRoot: true,
      secondRoot: false
    },
    initiallyShared: true,
    sharedAfterFirstReload: true
  });
});

test("refetches an asset graph after its last root was disposed", async ({ page }) => {
  let rootRequests = 0;
  await page.route("**/assets/reentered-root.glts", (route) => {
    rootRequests += 1;
    return fulfillGLTS(route, assetSource("root", "./reentered-child.glts"));
  });
  const childSources = [assetSource("old child"), assetSource("new child")];
  const childRevisions = await routeGLTSRevisions(
    page,
    "**/assets/reentered-child.glts",
    childSources
  );

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const first = await loader.loadAsync("/assets/reentered-root.glts");
    first.dispose();
    const afterDispose = {
      child: loader.has("/assets/reentered-child.glts"),
      root: loader.has("/assets/reentered-root.glts")
    };

    const second = await loader.loadAsync("/assets/reentered-root.glts");
    const childName = second.scene.children.at(0)?.children.at(0)?.children.at(0)?.name;
    loader.dispose();
    return { afterDispose, childName };
  });

  expect({ childRequests: childRevisions.requests, rootRequests, ...result }).toEqual({
    afterDispose: { child: false, root: false },
    childName: "new child",
    childRequests: 2,
    rootRequests: 2
  });
});

test("reactivates descendants when sharing an in-flight reload", async ({ page }) => {
  await routeGLTS(
    page,
    "**/assets/concurrent-root.glts",
    assetSource("root", "./concurrent-child.glts")
  );
  let childRequests = 0;
  await page.route("**/assets/concurrent-child.glts", async (route) => {
    childRequests += 1;
    if (childRequests === 2) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await fulfillGLTS(route, assetSource("child", "./concurrent-descendant.glts"));
  });
  const descendantSources = [assetSource("old descendant"), assetSource("new descendant")];
  const descendantRevisions = await routeGLTSRevisions(
    page,
    "**/assets/concurrent-descendant.glts",
    descendantSources
  );

  await page.goto("/test-harness.html");
  const descendantName = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const first = await loader.loadAsync("/assets/concurrent-root.glts");
    const childReload = loader.reload("/assets/concurrent-child.glts");
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.dispose();
    const second = await loader.loadAsync("/assets/concurrent-root.glts");
    await childReload;
    const name = second.scene.children.at(0)?.children.at(0)?.children.at(0)
      ?.children.at(0)?.children.at(0)?.name;
    loader.dispose();
    return name;
  });

  expect({
    childRequests,
    descendantName,
    descendantRequests: descendantRevisions.requests
  }).toEqual({
    childRequests: 2,
    descendantName: "new descendant",
    descendantRequests: 2
  });
});

test("keeps reachability on the latest queued root revision", async ({ page }) => {
  const rootSources = [
    assetSource("first", "./queued-first-child.glts"),
    assetSource("second", "./queued-second-child.glts"),
    assetSource("third")
  ];
  const rootRevisions = await routeGLTSRevisions(
    page,
    "**/assets/queued-root.glts",
    rootSources
  );
  await page.route(/.*\/assets\/queued-(?:first|second)-child\.glts/, (route) =>
    fulfillGLTS(route, assetSource("queued child"))
  );

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/queued-root.glts");
    const stableRoot = asset.scene;

    await Promise.all([
      loader.reload("/assets/queued-root.glts"),
      loader.reload("/assets/queued-root.glts")
    ]);

    const snapshot = {
      firstChild: loader.has("/assets/queued-first-child.glts"),
      latestName: asset.scene.children.at(0)?.name,
      root: loader.has("/assets/queued-root.glts"),
      secondChild: loader.has("/assets/queued-second-child.glts"),
      stableRoot: asset.scene === stableRoot
    };
    loader.dispose();
    return snapshot;
  });

  expect(rootRevisions.requests).toBe(3);
  expect(result).toEqual({
    firstChild: false,
    latestName: "third",
    root: true,
    secondChild: false,
    stableRoot: true
  });
});

test("preserves unused value imports because they can have side effects", async ({ page }) => {
  await routeGLTS(page, "**/assets/import-semantics.glts", `
      import { marker } from "https://fixtures.glts.test/side-effect.js"
      import * as THREE from "three"

      export default class ImportSemantics extends THREE.Group {}
    `);
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
  await routeGLTS(page, "**/assets/typescript-semantics.glts", `
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
    `);

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
  await routeGLTS(
    page,
    "**/assets/broken-typescript.glts",
    [
      "import * as THREE from \"three\"",
      "",
      "export default class Broken extends"
    ].join("\n")
  );

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
        phase: window.readErrorField(error, "phase"),
        url: window.readErrorField(error, "url")
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
    await fulfillGLTS(route, "export default class Broken extends");
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
