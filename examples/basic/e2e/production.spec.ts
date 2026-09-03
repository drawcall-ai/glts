import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { fulfillGLTS, routeGLTS } from "./routes.js";

test("isolates concurrent resource failures", async ({ page }) => {
  await routeGLTS(page, "**/assets/slow-success.glts", `
    import * as THREE from "three"
    import { loadingManager, scene } from "@drawcall/glts"
    scene.name = "success"
    new THREE.FileLoader(loadingManager).load(
      new URL("./slow.bin", import.meta.url).href,
    )
  `);
  await page.route("**/assets/failing.glts", (route) => route.abort("failed"));
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
    Reflect.set(globalThis, "__isolationLoader", loader);
    Reflect.set(globalThis, "__successfulLoad", loader.loadAsync("/assets/slow-success.glts"));
  });
  await requested.promise;
  const failure = await page.evaluate(async () => {
    const loader = Reflect.get(globalThis, "__isolationLoader");
    try {
      await loader.loadAsync("/assets/failing.glts");
      return "resolved";
    } catch (error) {
      return window.readErrorField(error, "url");
    }
  });
  expect(failure).toBe("http://127.0.0.1:5173/assets/failing.glts");

  release.resolve();
  const name = await page.evaluate(async () => {
    const node = await Reflect.get(globalThis, "__successfulLoad");
    const result = node.name;
    node.dispose();
    Reflect.get(globalThis, "__isolationLoader").dispose();
    return result;
  });
  expect(name).toBe("success");
});

test("rejects a pending load when its loader is disposed", async ({ page }) => {
  await routeGLTS(page, "**/assets/disposed-loading.glts", `
    import * as THREE from "three"
    import { loadingManager } from "@drawcall/glts"
    new THREE.FileLoader(loadingManager).load(
      new URL("./never.bin", import.meta.url).href,
    )
  `);
  const requested = deferred();
  const release = deferred();
  await page.route("**/assets/never.bin", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ body: "done", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    Reflect.set(globalThis, "__disposedLoader", loader);
    Reflect.set(globalThis, "__disposedLoad", loader.loadAsync("/assets/disposed-loading.glts"));
  });
  await requested.promise;
  const phase = await page.evaluate(async () => {
    Reflect.get(globalThis, "__disposedLoader").dispose();
    try {
      await Reflect.get(globalThis, "__disposedLoad");
      return "resolved";
    } catch (error) {
      return window.readErrorField(error, "phase");
    }
  });
  release.resolve();
  expect(phase).toBe("dispose");
});

test("disposes an unattached nested node when its parent fails", async ({ page }) => {
  await routeGLTS(page, "**/assets/orphan-child.glts", `
    import { onDispose } from "@drawcall/glts"
    globalThis.__orphanExecutions = (globalThis.__orphanExecutions ?? 0) + 1
    onDispose(() => {
      globalThis.__orphanDisposals = (globalThis.__orphanDisposals ?? 0) + 1
    })
  `);
  await routeGLTS(page, "**/assets/orphan-parent.glts", `
    import { gltsLoader } from "@drawcall/glts"
    await gltsLoader.loadAsync(new URL("./orphan-child.glts", import.meta.url))
    throw new Error("parent failed before scene.add")
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      await loader.loadAsync("/assets/orphan-parent.glts");
    } catch {
      // Expected.
    }
    await loader.reload("/assets/orphan-child.glts");
    const snapshot = {
      disposals: Reflect.get(globalThis, "__orphanDisposals"),
      executions: Reflect.get(globalThis, "__orphanExecutions")
    };
    loader.dispose();
    return snapshot;
  });

  expect(result).toEqual({ disposals: 1, executions: 1 });
});

test("balances LoadingManager callbacks that throw", async ({ page }) => {
  await routeGLTS(page, "**/assets/callback-failure.glts", `
    import * as THREE from "three"
    import { loadingManager, onDispose } from "@drawcall/glts"
    onDispose(() => { globalThis.__callbackFailureDisposals = 1 })
    new THREE.FileLoader(loadingManager).load(
      new URL("./missing.bin", import.meta.url).href,
    )
  `);
  await page.route("**/assets/missing.bin", (route) => route.abort("failed"));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    let completions = 0;
    manager.onLoad = () => { completions += 1; };
    manager.onError = () => { throw new Error("host onError failed"); };
    const loader = new window.GLTSLoader(manager);
    let rejected = false;
    try {
      await loader.loadAsync("/assets/callback-failure.glts");
    } catch {
      rejected = true;
    }
    const snapshot = {
      completions,
      disposals: Reflect.get(globalThis, "__callbackFailureDisposals"),
      rejected
    };
    loader.dispose();
    return snapshot;
  });

  expect(result).toEqual({ completions: 1, disposals: 1, rejected: true });
});

test("waits for an unawaited nested load before rejecting its parent", async ({ page }) => {
  await routeGLTS(page, "**/assets/early-failure-parent.glts", `
    import { gltsLoader } from "@drawcall/glts"
    void gltsLoader.loadAsync(new URL("./blocked-child.glts", import.meta.url))
    throw new Error("parent failed")
  `);
  const childRequested = deferred();
  const releaseChild = deferred();
  await page.route("**/assets/blocked-child.glts", async (route) => {
    childRequested.resolve();
    await releaseChild.promise;
    await fulfillGLTS(route, `
      import { onDispose } from "@drawcall/glts"
      globalThis.__blockedChildExecuted = true
      onDispose(() => { globalThis.__blockedChildDisposed = true })
    `);
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    Reflect.set(globalThis, "__earlyFailureLoader", loader);
    Reflect.set(globalThis, "__earlyFailureSettled", false);
    void loader.loadAsync("/assets/early-failure-parent.glts").then(
      () => { Reflect.set(globalThis, "__earlyFailureSettled", true); },
      () => { Reflect.set(globalThis, "__earlyFailureSettled", true); }
    );
  });
  await childRequested.promise;
  expect(await page.evaluate(() =>
    Reflect.get(globalThis, "__earlyFailureSettled")
  )).toBe(false);

  releaseChild.resolve();
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(globalThis, "__earlyFailureSettled")
  )).toBe(true);
  const lifecycle = await page.evaluate(() => {
    const result = {
      disposed: Reflect.get(globalThis, "__blockedChildDisposed"),
      executed: Reflect.get(globalThis, "__blockedChildExecuted")
    };
    Reflect.get(globalThis, "__earlyFailureLoader").dispose();
    return result;
  });
  expect(lifecycle).toEqual({ disposed: true, executed: true });
});

test("rejects when LoadingManager completion disposes the loader", async ({ page }) => {
  await routeGLTS(page, "**/assets/dispose-on-complete.glts", `
    import { onDispose } from "@drawcall/glts"
    onDispose(() => { globalThis.__completionDisposals = 1 })
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    const loader = new window.GLTSLoader(manager);
    manager.onLoad = () => loader.dispose();
    try {
      await loader.loadAsync("/assets/dispose-on-complete.glts");
      return { disposals: Reflect.get(globalThis, "__completionDisposals"), phase: "resolved" };
    } catch (error) {
      return {
        disposals: Reflect.get(globalThis, "__completionDisposals"),
        phase: window.readErrorField(error, "phase")
      };
    }
  });

  expect(result).toEqual({ disposals: 1, phase: "dispose" });
});
