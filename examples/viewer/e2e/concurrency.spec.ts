import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { fulfillGLTS, routeGLTS, routeGLTSRevisions } from "./routes.js";

test("completes concurrent loads of the same URL", async ({ page }) => {
  await routeGLTS(page, "**/assets/concurrent.glts", `
    import { scene } from "@drawcall/glts"
    scene.name = "concurrent"
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const nodes = await Promise.all([
      loader.loadAsync("/assets/concurrent.glts"),
      loader.loadAsync("/assets/concurrent.glts")
    ]);
    const snapshot = {
      distinct: nodes[0] !== nodes[1],
      names: nodes.map((node) => node.name)
    };
    nodes.forEach((node) => node.dispose());
    loader.dispose();
    return snapshot;
  });

  expect(result).toEqual({ distinct: true, names: ["concurrent", "concurrent"] });
});

test("loads the active revision after an overlapping reload", async ({ page }) => {
  const reloadRequested = deferred();
  const releaseReload = deferred();
  let requests = 0;
  await page.route("**/assets/reload-and-load.glts", async (route) => {
    requests += 1;
    const revision = requests === 1 ? "first" : "second";
    if (requests === 2) {
      reloadRequested.resolve();
      await releaseReload.promise;
    }
    await fulfillGLTS(route, `
      import { scene } from "@drawcall/glts"
      scene.name = ${JSON.stringify(revision)}
    `);
  });

  await page.goto("/test-harness.html");
  await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const first = await loader.loadAsync("/assets/reload-and-load.glts");
    Reflect.set(globalThis, "__overlapLoader", loader);
    Reflect.set(globalThis, "__overlapFirst", first);
    Reflect.set(globalThis, "__overlapReload", loader.reload("/assets/reload-and-load.glts"));
  });
  await reloadRequested.promise;
  await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__overlapLoader");
    Reflect.set(globalThis, "__overlapSecond", loader.loadAsync("/assets/reload-and-load.glts"));
  });
  releaseReload.resolve();

  const result = await page.evaluate(async () => {
    await Reflect.get(globalThis, "__overlapReload");
    const first = Reflect.get(globalThis, "__overlapFirst");
    const second = await Reflect.get(globalThis, "__overlapSecond");
    const snapshot = { first: first.name, second: second.name };
    first.dispose();
    second.dispose();
    Reflect.get(globalThis, "__overlapLoader").dispose();
    return snapshot;
  });
  expect(result).toEqual({ first: "second", second: "second" });
  expect(requests).toBe(2);
});

test("keeps a host load behind a cross-URL queued reload", async ({ page }) => {
  await routeGLTSRevisions(page, "**/assets/queued-target.glts", [
    'import { scene } from "@drawcall/glts"; scene.name = "first"',
    'import { scene } from "@drawcall/glts"; scene.name = "second"'
  ]);
  const blockerRequested = deferred();
  const releaseBlocker = deferred();
  let blockerRequests = 0;
  await page.route("**/assets/reload-blocker.glts", async (route) => {
    blockerRequests += 1;
    if (blockerRequests === 2) {
      blockerRequested.resolve();
      await releaseBlocker.promise;
    }
    await fulfillGLTS(route, 'import { scene } from "@drawcall/glts"');
  });

  await page.goto("/test-harness.html");
  await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const [target, blocker] = await Promise.all([
      loader.loadAsync("/assets/queued-target.glts"),
      loader.loadAsync("/assets/reload-blocker.glts")
    ]);
    Reflect.set(globalThis, "__queuedLoader", loader);
    Reflect.set(globalThis, "__queuedTarget", target);
    Reflect.set(globalThis, "__reloadBlocker", blocker);
    Reflect.set(globalThis, "__blockingReload", blocker.reload());
  });
  await blockerRequested.promise;
  await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__queuedLoader");
    const target = Reflect.get(globalThis, "__queuedTarget");
    Reflect.set(globalThis, "__queuedReload", target.reload());
    Reflect.set(globalThis, "__queuedLoad", loader.loadAsync("/assets/queued-target.glts"));
  });
  releaseBlocker.resolve();

  const name = await page.evaluate(async () => {
    await Reflect.get(globalThis, "__blockingReload");
    await Reflect.get(globalThis, "__queuedReload");
    const target = Reflect.get(globalThis, "__queuedTarget");
    const loaded = await Reflect.get(globalThis, "__queuedLoad");
    const result = loaded.name;
    target.dispose();
    loaded.dispose();
    Reflect.get(globalThis, "__reloadBlocker").dispose();
    Reflect.get(globalThis, "__queuedLoader").dispose();
    return result;
  });

  expect(name).toBe("second");
});

test("rejects concurrent cyclic roots instead of deadlocking", async ({ page }) => {
  await routeGLTS(page, "**/assets/cycle-a.glts", `
    import { gltsLoader, scene } from "@drawcall/glts"
    scene.add(await gltsLoader.loadAsync(new URL("./cycle-b.glts", import.meta.url)))
  `);
  await routeGLTS(page, "**/assets/cycle-b.glts", `
    import { gltsLoader, scene } from "@drawcall/glts"
    scene.add(await gltsLoader.loadAsync(new URL("./cycle-a.glts", import.meta.url)))
  `);

  await page.goto("/test-harness.html");
  const statuses = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const loads = Promise.allSettled([
      loader.loadAsync("/assets/cycle-a.glts"),
      loader.loadAsync("/assets/cycle-b.glts")
    ]);
    const result = await Promise.race([
      loads.then((outcomes) => outcomes.map(({ status }) => status)),
      new Promise<string[]>((resolve) => {
        setTimeout(() => resolve(["timeout"]), 1000);
      })
    ]);
    loader.dispose();
    return result;
  });

  expect(statuses).toEqual(["rejected", "rejected"]);
});

test("serializes mutually recursive reloads without deadlocking", async ({ page }) => {
  await routeGLTSRevisions(page, "**/assets/reload-cycle-a.glts", [
    'import { scene } from "@drawcall/glts"; scene.name = "a1"',
    `
      import { gltsLoader, scene } from "@drawcall/glts"
      scene.name = "a2"
      scene.add(await gltsLoader.loadAsync(
        new URL("./reload-cycle-b.glts", import.meta.url),
      ))
    `
  ]);
  await routeGLTSRevisions(page, "**/assets/reload-cycle-b.glts", [
    'import { scene } from "@drawcall/glts"; scene.name = "b1"',
    `
      import { gltsLoader, scene } from "@drawcall/glts"
      scene.name = "b2"
      scene.add(await gltsLoader.loadAsync(
        new URL("./reload-cycle-a.glts", import.meta.url),
      ))
    `
  ]);

  await page.goto("/test-harness.html");
  const statuses = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const [a, b] = await Promise.all([
      loader.loadAsync("/assets/reload-cycle-a.glts"),
      loader.loadAsync("/assets/reload-cycle-b.glts")
    ]);
    const reloads = Promise.allSettled([a.reload(), b.reload()]);
    const result = await Promise.race([
      reloads.then((outcomes) => outcomes.map(({ status }) => status)),
      new Promise<string[]>((resolve) => {
        setTimeout(() => resolve(["timeout"]), 1000);
      })
    ]);
    a.dispose();
    b.dispose();
    loader.dispose();
    return result;
  });

  expect(statuses).not.toEqual(["timeout"]);
  expect(statuses).toContain("rejected");
});

test("does not deadlock a mutually recursive load and reload", async ({ page }) => {
  await routeGLTSRevisions(page, "**/assets/mixed-cycle-a.glts", [
    'import { scene } from "@drawcall/glts"; scene.name = "a1"',
    `
      import { gltsLoader, scene } from "@drawcall/glts"
      scene.add(await gltsLoader.loadAsync(
        new URL("./mixed-cycle-b.glts", import.meta.url),
      ))
    `
  ]);
  await routeGLTS(page, "**/assets/mixed-cycle-b.glts", `
    import { gltsLoader, scene } from "@drawcall/glts"
    scene.add(await gltsLoader.loadAsync(
      new URL("./mixed-cycle-a.glts", import.meta.url),
    ))
  `);

  await page.goto("/test-harness.html");
  const statuses = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const a = await loader.loadAsync("/assets/mixed-cycle-a.glts");
    const operations = Promise.allSettled([
      a.reload(),
      loader.loadAsync("/assets/mixed-cycle-b.glts")
    ]);
    const result = await Promise.race([
      operations.then((outcomes) => outcomes.map(({ status }) => status)),
      new Promise<string[]>((resolve) => {
        setTimeout(() => resolve(["timeout"]), 1000);
      })
    ]);
    a.dispose();
    loader.dispose();
    return result;
  });

  expect(statuses).not.toEqual(["timeout"]);
  expect(statuses).toContain("rejected");
});
