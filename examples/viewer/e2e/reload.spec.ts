import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { fulfillScript, routeScript, routeScriptRevisions } from "./routes.js";

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
    await fulfillScript(route, `
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
    void loader.reload("/assets/reload-race.glts").then(
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

test("serializes reloads of the same URL", async ({ page }) => {
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
    await fulfillScript(route, resource);
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
    Reflect.set(globalThis, "__firstReload", "pending");
    void loader.reload("/assets/serialized.glts").then(
      () => { Reflect.set(globalThis, "__firstReload", "resolved"); },
      () => { Reflect.set(globalThis, "__firstReload", "rejected"); }
    );
  });

  await resourceRequested.promise;
  await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__serializedLoader");
    Reflect.set(globalThis, "__secondReload", "pending");
    void loader.reload("/assets/serialized.glts").then(
      () => { Reflect.set(globalThis, "__secondReload", "resolved"); },
      () => { Reflect.set(globalThis, "__secondReload", "rejected"); }
    );
  });
  await page.waitForTimeout(50);
  expect(requests).toBe(2);

  releaseResource.resolve();
  await expect.poll(() => page.evaluate(() => ({
    first: Reflect.get(globalThis, "__firstReload"),
    second: Reflect.get(globalThis, "__secondReload")
  }))).toEqual({ first: "resolved", second: "resolved" });

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
  await routeScriptRevisions(page, "**/assets/manager-order.glts", [
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
    await loader.reload("/assets/manager-order.glts");
    const name = node.name;
    node.dispose();
    loader.dispose();
    return { name, nameAtCompletion };
  });

  expect(result).toEqual({ name: "second", nameAtCompletion: "second" });
});

test("fails a reload instead of replacing a same-source node disposed by an earlier commit", async ({ page }) => {
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
  await routeScriptRevisions(page, "**/assets/nested-reload.glts", [
    source("first"),
    source("second")
  ]);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const outer = await loader.loadAsync("/assets/nested-reload.glts");
    const nested = await loader.loadAsync("/assets/nested-reload.glts");
    outer.add(nested);
    let reloadError = "";
    try {
      await loader.reload("/assets/nested-reload.glts");
    } catch (error) {
      reloadError = error instanceof Error ? error.message : String(error);
    }

    let nestedDisposed = false;
    try {
      nested.update(0);
    } catch {
      nestedDisposed = true;
    }

    const snapshot = {
      disposalsBeforeDispose: Reflect.get(globalThis, "__nestedReloadDisposals"),
      executions: Reflect.get(globalThis, "__nestedReloadExecutions"),
      name: outer.name,
      nestedDisposed,
      reloadError
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
    nestedDisposed: true,
    reloadError: expect.stringContaining("Reload committed, but replacing its nodes failed")
  });
});

test("cleans up when a script prevents node augmentation", async ({ page }) => {
  await routeScript(page, "**/assets/frozen.glts", `
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
  await page.route("**/assets/redirect.glts", (route) => route.fulfill({
    status: 302,
    headers: { location: new URL("/e2e/redirected.glts", route.request().url()).href }
  }));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadAsync("/assets/redirect.glts");
    const url = node.url;
    await loader.reload("/assets/redirect.glts");
    const name = node.name;
    node.dispose();
    loader.dispose();
    return { name, url };
  });

  expect(result).toEqual({
    name: "execution 2",
    url: new URL("/assets/redirect.glts", page.url()).href
  });
});
