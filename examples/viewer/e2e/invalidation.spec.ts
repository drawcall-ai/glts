import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { fulfillGLTS } from "./routes.js";

test("reopens inactive root, nested and cross-frame sources after canonical reloads", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/*.glts", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    // Read while fetching, so a cached source keeps the version it was fetched at.
    const version: unknown = await page.evaluate(() => Reflect.get(globalThis, "__invalidatedVersion"));
    const child = path === "/frame/root.glts" ? `
      import { gltsLoader } from "@drawcall/glts"
      scene.add(await gltsLoader.loadAsync(new URL("./nested.glts", import.meta.url)))
      scene.add(await gltsLoader.loadAsync(new URL("../other/shared.glts", import.meta.url)))
    ` : "";
    await fulfillGLTS(route, `
      import { scene, onDispose } from "@drawcall/glts"
      scene.name = "${path} v${version}"
      globalThis.__invalidatedExecutions = (globalThis.__invalidatedExecutions ?? 0) + 1
      onDispose(() => {
        globalThis.__invalidatedDisposals = (globalThis.__invalidatedDisposals ?? 0) + 1
      })
      ${child}
    `);
  });

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    Reflect.set(globalThis, "__invalidatedVersion", 1);
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const first = await loader.loadAsync("/frame/root.glts");
    const unchanged = await loader.loadAsync("/unchanged.glts");
    first.dispose();
    unchanged.dispose();
    Reflect.set(globalThis, "__invalidatedVersion", 2);
    const before = { executions: Reflect.get(globalThis, "__invalidatedExecutions"), disposals: Reflect.get(globalThis, "__invalidatedDisposals") };
    await loader.reload("/frame/./root.glts#edit");
    await loader.reload(new URL("/frame/nested.glts#edit", location.href));
    await loader.reload("/frame/../other/shared.glts");
    await loader.reload("/unknown.glts");
    const after = { executions: Reflect.get(globalThis, "__invalidatedExecutions"), disposals: Reflect.get(globalThis, "__invalidatedDisposals") };
    const reopened = await loader.loadAsync("/frame/root.glts");
    const cached = await loader.loadAsync("/unchanged.glts");
    const names = [reopened.name, ...reopened.children.map((node) => node.name), cached.name];
    Reflect.set(globalThis, "__invalidatedVersion", 3);
    await loader.reload("/other/shared.glts");
    const future = await loader.loadAsync("/other/shared.glts");
    const activeNames = [reopened.name, ...reopened.children.map((node) => node.name), future.name];
    const snapshot = { before, after, names, activeNames };
    loader.dispose();
    return snapshot;
  });
  expect(result.after).toEqual(result.before);
  expect(result.names).toEqual(["/frame/root.glts v2", "/frame/nested.glts v2", "/other/shared.glts v2", "/unchanged.glts v1"]);
  expect(result.activeNames).toEqual(["/frame/root.glts v2", "/frame/nested.glts v2", "/other/shared.glts v3", "/other/shared.glts v3"]);
  // Reloading inactive sources fetches nothing; the next load fetches them again.
  expect(requests).toEqual(["/frame/root.glts", "/frame/nested.glts", "/other/shared.glts", "/unchanged.glts", "/frame/root.glts", "/frame/nested.glts", "/other/shared.glts", "/other/shared.glts"]);
});

for (const { failure, phase, broken } of [
  { failure: "fetch", phase: "fetch", broken: { status: 503, body: "unavailable" } },
  { failure: "compile", phase: "transform", broken: { body: "const =" } },
  { failure: "execute", phase: "evaluate", broken: { body: 'throw new Error("broken source")' } }
]) {
  test(`keeps live content on ${failure} failure but never reuses its invalidated source`, async ({ page }) => {
    const responses = [
      { body: 'import { scene } from "@drawcall/glts"; scene.name = "v1"' },
      broken,
      { body: 'import { scene } from "@drawcall/glts"; scene.name = "v2"' }
    ];
    let requests = 0;
    await page.route("**/root.glts", (route) => route.fulfill(responses[requests++] ?? { status: 404 }));

    await page.goto("/test-harness.html");
    const result = await page.evaluate(async () => {
      const loader = new window.GLTSLoader(new window.LoadingManager());
      const live = await loader.loadAsync("/root.glts");
      let phase: unknown;
      try { await loader.reload("/root.glts"); }
      catch (error) { phase = window.readErrorField(error, "phase"); }
      const preserved = live.name;
      live.dispose();
      const next = await loader.loadAsync("/root.glts");
      const name = next.name;
      loader.dispose();
      return { phase, preserved, name };
    });
    expect(result.phase).toBe(phase);
    expect(result.preserved).toBe("v1");
    expect(result.name).toBe("v2");
    expect(requests).toBe(3);
  });
}

for (const { failure, phase, broken } of [
  { failure: "fetch", phase: "fetch", broken: { status: 503, body: "unavailable" } },
  { failure: "compile", phase: "transform", broken: { body: "const =" } }
]) {
  test(`retries shared ${failure} failures and caches the successful result`, async ({ page }) => {
    const responses = [broken, { body: 'import { scene } from "@drawcall/glts"; scene.name = "recovered"' }];
    let requests = 0;
    await page.route("**/retry.glts", (route) => route.fulfill(responses[requests++] ?? { status: 404 }));

    await page.goto("/test-harness.html");
    const result = await page.evaluate(async () => {
      const loader = new window.GLTSLoader(new window.LoadingManager());
      const attempts = await Promise.allSettled([
        loader.loadAsync("/retry.glts"), loader.loadAsync("/retry.glts")
      ]);
      const phases = attempts.map((result) => result.status === "rejected"
        ? window.readErrorField(result.reason, "phase") : "unexpected success");
      const recovered = await loader.loadAsync("/retry.glts");
      const cached = await loader.loadAsync("/retry.glts");
      const snapshot = { phases, names: [recovered.name, cached.name] };
      loader.dispose();
      return snapshot;
    });
    expect(result).toEqual({ phases: [phase, phase], names: ["recovered", "recovered"] });
    expect(requests).toBe(2);
  });
}

test("reload waits for a pending load and refreshes its live result and future loads", async ({ page }) => {
  const requested = deferred();
  const release = deferred();
  let requests = 0;
  await page.route("**/pending.glts", async (route) => {
    const version = ++requests;
    if (version === 1) {
      requested.resolve();
      await release.promise;
    }
    await fulfillGLTS(route, `import { scene } from "@drawcall/glts"; scene.name = "v${version}"`);
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    Reflect.set(globalThis, "__pendingLoader", loader);
    Reflect.set(globalThis, "__pendingLoad", loader.loadAsync("/pending.glts"));
  });
  await requested.promise;
  await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__pendingLoader");
    Reflect.set(globalThis, "__pendingReload", loader.reload("/pending.glts#edit"));
  });
  release.resolve();
  const result = await page.evaluate(async () => {
    const loader = Reflect.get(globalThis, "__pendingLoader");
    const live = await Reflect.get(globalThis, "__pendingLoad");
    await Reflect.get(globalThis, "__pendingReload");
    const future = await loader.loadAsync("/pending.glts");
    const snapshot = { live: live.name, future: future.name };
    loader.dispose();
    return snapshot;
  });
  expect(result).toEqual({ live: "v2", future: "v2" });
  expect(requests).toBe(2);
});

test("invalidates inactive instances through the same path and URL modifier as loading", async ({ page }) => {
  let requests = 0;
  await page.route("**/actual/scene.glts", (route) => {
    requests += 1;
    return fulfillGLTS(route, `
      import { scene, onMatrixUpdateAt } from "@drawcall/glts"
      onMatrixUpdateAt(() => {})
      scene.name = "v${requests}"
    `);
  });

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    manager.setURLModifier((url) => url.replace("/logical/", "/actual/"));
    const loader = new window.GLTSLoader(manager).setPath("/logical/");
    const first = await loader.loadInstancesAsync("scene.glts", 2);
    first.dispose();
    await loader.reload("./scene.glts#changed");
    const second = await loader.loadInstancesAsync("scene.glts", 2);
    const snapshot = { name: second.name, count: second.count, url: second.url };
    loader.dispose();
    return snapshot;
  });
  // The reload of the inactive script fetches nothing, but the next load fetches it again.
  expect(requests).toBe(2);
  expect(result).toEqual({ name: "v2", count: 2, url: new URL("/actual/scene.glts", page.url()).href });
});
