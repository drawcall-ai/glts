import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { routeGLTS, routeGLTSRevisions } from "./routes.js";

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
  await routeGLTSRevisions(page, "**/assets/resource-reload.glts", [
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
      await node.reload();
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
  await routeGLTS(page, "**/assets/tracked.glts", `
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
