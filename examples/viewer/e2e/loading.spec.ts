import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { fulfillScript, routeScript, routeScriptRevisions } from "./routes.js";

test("evaluates shared helpers and packages once and constructs query variants independently", async ({ page }) => {
  const requests: string[] = [];
  const sources: Record<string, string> = {
    "/assets/variants.glts": `
      import { scene } from "@drawcall/glts"
      import { value } from "./variants-helper.ts"
      import { suffix } from "variants-package"
      globalThis.__variantExecutions = (globalThis.__variantExecutions ?? 0) + 1
      scene.name = value + suffix
      scene.userData.execution = globalThis.__variantExecutions
      scene.userData.importURL = import.meta.url
      scene.userData.contextURL = scene.source.url
      await Promise.resolve()
      scene.userData.resumedURL = import.meta.url
    `,
    "/assets/variants-helper.ts": `
      globalThis.__variantHelpers = (globalThis.__variantHelpers ?? 0) + 1
      export const value: string = "shared"
    `,
    "/cdn/variants-package": `
      globalThis.__variantPackages = (globalThis.__variantPackages ?? 0) + 1
      export const suffix = " graph"
    `
  };
  await page.route(/\/(?:assets|cdn)\/variants/, (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const source = sources[path];
    return source === undefined ? route.fulfill({ status: 404 }) : fulfillScript(route, source);
  });

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      cdnURL: new URL("/cdn/", location.href)
    });
    try {
      const scenes = await Promise.all([
        loader.loadAsync("/assets/variants.glts?variant=1"),
        loader.loadAsync("/assets/variants.glts?variant=2")
      ]);
      return {
        distinct: scenes[0] !== scenes[1],
        helpers: Reflect.get(globalThis, "__variantHelpers"),
        packages: Reflect.get(globalThis, "__variantPackages"),
        scenes: scenes.map((scene) => ({
          name: scene.name,
          url: scene.url,
          source: scene.source.url,
          ...scene.userData
        }))
      };
    } finally {
      loader.dispose();
    }
  });

  expect(requests.sort()).toEqual([
    "/assets/variants-helper.ts",
    "/assets/variants.glts",
    "/cdn/variants-package"
  ]);
  expect(result.distinct).toBe(true);
  expect(result.helpers).toBe(1);
  expect(result.packages).toBe(1);
  // Concurrent variants run in either order, each once.
  expect(result.scenes.map((scene) => Reflect.get(scene, "execution")).sort()).toEqual([1, 2]);
  expect(result.scenes).toEqual([1, 2].map((variant) => {
    const url = new URL(`/assets/variants.glts?variant=${variant}`, page.url()).href;
    return { name: "shared graph", execution: expect.any(Number), url, source: url, importURL: url, contextURL: url, resumedURL: url };
  }));
});

test("rejects unsupported per-load progress callbacks", async ({ page }) => {
  await page.goto("/test-harness.html");
  const message = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      await loader.loadAsync("/assets/unused.glts", () => undefined);
    } catch (error) {
      loader.dispose();
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("Expected progress callback rejection");
  });

  expect(message).toContain("use LoadingManager.onProgress");
});

test("keeps the current revision when an unawaited reload resource fails", async ({ page }) => {
  await routeScriptRevisions(page, "**/assets/resource-reload.glts", [
    `
      import { onDispose, scene } from "@drawcall/glts"
      scene.name = "current"
      onDispose(() => {
        globalThis.__currentRevisionDisposals =
          (globalThis.__currentRevisionDisposals ?? 0) + 1
      })
    `,
    `
      import * as THREE from "three"
      import { loadingManager, onDispose, scene } from "@drawcall/glts"
      scene.name = "failed replacement"
      new THREE.FileLoader(loadingManager).load(
        new URL("./failed-resource.bin", import.meta.url).href,
      )
      onDispose(() => {
        globalThis.__failedRevisionDisposals =
          (globalThis.__failedRevisionDisposals ?? 0) + 1
      })
    `
  ]);
  await page.route("**/assets/failed-resource.bin", (route) => route.fulfill({
    body: "failed",
    status: 500
  }));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadAsync("/assets/resource-reload.glts");
    let rejected = false;
    try {
      await loader.reload("/assets/resource-reload.glts");
    } catch {
      rejected = true;
    }
    const snapshot = {
      failedDisposals: Reflect.get(globalThis, "__failedRevisionDisposals"),
      name: node.name,
      oldDisposalsBeforeDispose: Reflect.get(globalThis, "__currentRevisionDisposals"),
      rejected
    };
    node.dispose();
    loader.dispose();
    return {
      ...snapshot,
      oldDisposalsAfterDispose: Reflect.get(globalThis, "__currentRevisionDisposals")
    };
  });

  expect(result).toEqual({
    failedDisposals: 1,
    name: "current",
    oldDisposalsAfterDispose: 1,
    oldDisposalsBeforeDispose: undefined,
    rejected: true
  });
});

test("waits for manager-tracked work even when a script does not await it", async ({ page }) => {
  await routeScript(page, "**/assets/tracked.glts", `
    import * as THREE from "three"
    import { loadingManager, scene } from "@drawcall/glts"
    new THREE.FileLoader(loadingManager).load(
      new URL("./slow.bin", import.meta.url).href,
    )
    scene.name = "tracked"
  `);
  const requested = deferred();
  const release = deferred();
  await page.route("**/assets/slow.bin", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ body: "done", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    Reflect.set(globalThis, "__trackedLoader", loader);
    Reflect.set(globalThis, "__trackedSettled", false);
    void loader.loadAsync("/assets/tracked.glts").then((scene) => {
      Reflect.set(globalThis, "__trackedScene", scene);
      Reflect.set(globalThis, "__trackedSettled", true);
    });
  });
  await requested.promise;
  expect(await page.evaluate(() => Reflect.get(globalThis, "__trackedSettled"))).toBe(false);

  release.resolve();
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, "__trackedSettled")))
    .toBe(true);
  await page.evaluate(() => {
    Reflect.get(globalThis, "__trackedScene").dispose();
    Reflect.get(globalThis, "__trackedLoader").dispose();
  });
});
