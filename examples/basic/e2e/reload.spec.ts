import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { fulfillGLTS, routeGLTS, routeGLTSRevisions } from "./routes.js";

test("disposes a replacement when its node is disposed during reload", async ({ page }) => {
  const reloadRequested = deferred();
  const releaseReload = deferred();
  let requests = 0;
  await page.route("**/assets/reload-race.glts", async (route) => {
    requests += 1;
    if (requests === 2) {
      reloadRequested.resolve();
      await releaseReload.promise;
    }
    await fulfillGLTS(route, `
      import { onDispose, scene } from "@drawcall/glts"
      scene.name = "revision ${requests}"
      onDispose(() => {
        globalThis.__reloadRaceDisposals = (globalThis.__reloadRaceDisposals ?? 0) + 1
      })
    `);
  });

  await page.goto("/test-harness.html");
  await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadAsync("/assets/reload-race.glts");
    Reflect.set(globalThis, "__reloadRaceLoader", loader);
    Reflect.set(globalThis, "__reloadRaceNode", node);
    Reflect.set(globalThis, "__reloadRaceResult", "pending");
    void node.reload().then(
      () => { Reflect.set(globalThis, "__reloadRaceResult", "resolved"); },
      (error: unknown) => {
        Reflect.set(
          globalThis,
          "__reloadRaceResult",
          error instanceof Error ? error.message : String(error)
        );
      }
    );
  });

  await reloadRequested.promise;
  await page.evaluate(() => {
    Reflect.get(globalThis, "__reloadRaceNode").dispose();
  });
  releaseReload.resolve();
  await expect.poll(() =>
    page.evaluate(() => Reflect.get(globalThis, "__reloadRaceResult"))
  ).not.toBe("pending");

  const result = await page.evaluate(() => {
    const snapshot = {
      disposals: Reflect.get(globalThis, "__reloadRaceDisposals"),
      result: Reflect.get(globalThis, "__reloadRaceResult")
    };
    Reflect.get(globalThis, "__reloadRaceLoader").dispose();
    return snapshot;
  });
  expect(result.disposals).toBe(2);
  expect(result.result).toContain("disposed during reload");
});

test("serializes node and loader reloads for the same URL", async ({ page }) => {
  const resourceRequested = deferred();
  const releaseResource = deferred();
  let requests = 0;
  await page.route("**/assets/serialized.glts", async (route) => {
    requests += 1;
    const resource = requests === 2
      ? `
        import * as THREE from "three"
        import { loadingManager, scene } from "@drawcall/glts"
        new THREE.FileLoader(loadingManager).load(
          new URL("./serialized.bin", import.meta.url).href,
        )
        scene.name = "revision 2"
      `
      : `
        import { scene } from "@drawcall/glts"
        scene.name = "revision ${requests}"
      `;
    await fulfillGLTS(route, resource);
  });
  await page.route("**/assets/serialized.bin", async (route) => {
    resourceRequested.resolve();
    await releaseResource.promise;
    await route.fulfill({ body: "ready", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadAsync("/assets/serialized.glts");
    Reflect.set(globalThis, "__serializedLoader", loader);
    Reflect.set(globalThis, "__serializedNode", node);
    Reflect.set(globalThis, "__nodeReload", "pending");
    void node.reload().then(
      () => { Reflect.set(globalThis, "__nodeReload", "resolved"); },
      () => { Reflect.set(globalThis, "__nodeReload", "rejected"); }
    );
  });

  await resourceRequested.promise;
  await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__serializedLoader");
    Reflect.set(globalThis, "__loaderReload", "pending");
    void loader.reload("/assets/serialized.glts").then(
      () => { Reflect.set(globalThis, "__loaderReload", "resolved"); },
      () => { Reflect.set(globalThis, "__loaderReload", "rejected"); }
    );
  });
  await page.waitForTimeout(50);
  expect(requests).toBe(2);

  releaseResource.resolve();
  await expect.poll(() => page.evaluate(() => ({
    loader: Reflect.get(globalThis, "__loaderReload"),
    node: Reflect.get(globalThis, "__nodeReload")
  }))).toEqual({ loader: "resolved", node: "resolved" });

  const name = await page.evaluate(() => {
    const node = Reflect.get(globalThis, "__serializedNode");
    const result = node.name;
    node.dispose();
    Reflect.get(globalThis, "__serializedLoader").dispose();
    return result;
  });
  expect(requests).toBe(3);
  expect(name).toBe("revision 3");
});

test("notifies LoadingManager completion after a reload commits", async ({ page }) => {
  await routeGLTSRevisions(page, "**/assets/manager-order.glts", [
    `
      import { scene } from "@drawcall/glts"
      scene.name = "first"
    `,
    `
      import { scene } from "@drawcall/glts"
      scene.name = "second"
    `
  ]);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    const loader = new window.GLTSLoader(manager);
    const node = await loader.loadAsync("/assets/manager-order.glts");
    let nameAtCompletion = "unset";
    manager.onLoad = () => {
      nameAtCompletion = node.name;
    };
    await node.reload();
    const name = node.name;
    node.dispose();
    loader.dispose();
    return { name, nameAtCompletion };
  });

  expect(result).toEqual({ name: "second", nameAtCompletion: "second" });
});

test("does not replace a same-source node disposed by an earlier commit", async ({ page }) => {
  const source = (revision: string) => `
    import { onDispose, scene } from "@drawcall/glts"
    globalThis.__nestedReloadExecutions =
      (globalThis.__nestedReloadExecutions ?? 0) + 1
    scene.name = ${JSON.stringify(revision)}
    onDispose(() => {
      globalThis.__nestedReloadDisposals =
        (globalThis.__nestedReloadDisposals ?? 0) + 1
    })
  `;
  await routeGLTSRevisions(page, "**/assets/nested-reload.glts", [
    source("first"),
    source("second")
  ]);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const outer = await loader.loadAsync("/assets/nested-reload.glts");
    const nested = await loader.loadAsync("/assets/nested-reload.glts");
    outer.add(nested);
    await loader.reload("/assets/nested-reload.glts");

    let nestedDisposed = false;
    try {
      await nested.reload();
    } catch {
      nestedDisposed = true;
    }

    const snapshot = {
      disposalsBeforeDispose: Reflect.get(globalThis, "__nestedReloadDisposals"),
      executions: Reflect.get(globalThis, "__nestedReloadExecutions"),
      name: outer.name,
      nestedDisposed
    };
    outer.dispose();
    loader.dispose();
    return {
      ...snapshot,
      disposalsAfterDispose: Reflect.get(globalThis, "__nestedReloadDisposals")
    };
  });

  expect(result).toEqual({
    disposalsAfterDispose: 4,
    disposalsBeforeDispose: 3,
    executions: 4,
    name: "second",
    nestedDisposed: true
  });
});

test("cleans up when a script prevents managed node augmentation", async ({ page }) => {
  await routeGLTS(page, "**/assets/frozen.glts", `
    import { onDispose, scene } from "@drawcall/glts"
    onDispose(() => { globalThis.__frozenDisposals = 1 })
    Object.preventExtensions(scene)
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    let rejected = false;
    try {
      await loader.loadAsync("/assets/frozen.glts");
    } catch {
      rejected = true;
    }
    const disposals = Reflect.get(globalThis, "__frozenDisposals");
    loader.dispose();
    return { disposals, rejected };
  });

  expect(result).toEqual({ disposals: 1, rejected: true });
});

test("reloads a requested URL that redirects to the source", async ({ page }) => {
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    let revision = 0;
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      fetch: async () => {
        revision += 1;
        const response = new Response(`
          import { scene } from "@drawcall/glts"
          scene.name = "revision ${revision}"
        `);
        Object.defineProperty(response, "url", {
          value: new URL("/assets/redirected.glts", location.href).href
        });
        return response;
      }
    });
    const node = await loader.loadAsync("/assets/redirect.glts");
    const url = node.url;
    await loader.reload("/assets/redirect.glts");
    const name = node.name;
    node.dispose();
    loader.dispose();
    return { name, url };
  });

  expect(result).toEqual({
    name: "revision 2",
    url: "http://127.0.0.1:5173/assets/redirect.glts"
  });
});
