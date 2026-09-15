import { expect, test } from "@playwright/test";

test("reopens inactive root, nested and cross-frame sources after canonical reloads", async ({ page }) => {
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    let version = 1;
    const requests: string[] = [];
    const cacheModes: (RequestCache | undefined)[] = [];
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      fetch: async (input, options) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        cacheModes.push(options?.cache);
        const child = path === "/frame/root.glts" ? `
          import { gltsLoader } from "@drawcall/glts"
          scene.add(await gltsLoader.loadAsync(new URL("./nested.glts", import.meta.url)))
          scene.add(await gltsLoader.loadAsync(new URL("../other/shared.glts", import.meta.url)))
        ` : "";
        return new Response(`
          import { scene, onDispose } from "@drawcall/glts"
          scene.name = "${path} v${version}"
          globalThis.__invalidatedExecutions = (globalThis.__invalidatedExecutions ?? 0) + 1
          onDispose(() => {
            globalThis.__invalidatedDisposals = (globalThis.__invalidatedDisposals ?? 0) + 1
          })
          ${child}
        `);
      }
    });
    const first = await loader.loadAsync("/frame/root.glts");
    const unchanged = await loader.loadAsync("/unchanged.glts");
    first.dispose();
    unchanged.dispose();
    version = 2;
    const before = { requests: requests.length, executions: Reflect.get(globalThis, "__invalidatedExecutions"), disposals: Reflect.get(globalThis, "__invalidatedDisposals") };
    await loader.reload("/frame/./root.glts#edit");
    await loader.reload(new URL("/frame/nested.glts#edit", location.href));
    await loader.reload("/frame/../other/shared.glts");
    await loader.reload("/unknown.glts");
    const after = { requests: requests.length, executions: Reflect.get(globalThis, "__invalidatedExecutions"), disposals: Reflect.get(globalThis, "__invalidatedDisposals") };
    const reopened = await loader.loadAsync("/frame/root.glts");
    const cached = await loader.loadAsync("/unchanged.glts");
    const names = [reopened.name, ...reopened.children.map((node) => node.name), cached.name];
    version = 3;
    await loader.reload("/other/shared.glts");
    const future = await loader.loadAsync("/other/shared.glts");
    const activeNames = [reopened.name, ...reopened.children.map((node) => node.name), future.name];
    const snapshot = { before, after, names, activeNames, requests, cacheModes };
    loader.dispose();
    return snapshot;
  });
  expect(result.after).toEqual(result.before);
  expect(result.names).toEqual(["/frame/root.glts v2", "/frame/nested.glts v2", "/other/shared.glts v2", "/unchanged.glts v1"]);
  expect(result.activeNames).toEqual(["/frame/root.glts v2", "/frame/nested.glts v2", "/other/shared.glts v3", "/other/shared.glts v3"]);
  expect(result.requests).toEqual(["/frame/root.glts", "/frame/nested.glts", "/other/shared.glts", "/unchanged.glts", "/frame/root.glts", "/frame/nested.glts", "/other/shared.glts", "/other/shared.glts"]);
  expect(result.cacheModes).toEqual(["no-cache", "no-cache", "no-cache", "no-cache", "no-cache", "no-cache", "no-cache", "no-cache"]);
});

for (const { failure, phase } of [
  { failure: "fetch", phase: "fetch" },
  { failure: "compile", phase: "transform" },
  { failure: "execute", phase: "evaluate" }
]) {
  test(`keeps live content on ${failure} failure but never reuses its invalidated source`, async ({ page }) => {
    await page.goto("/test-harness.html");
    const result = await page.evaluate(async (failure) => {
      let version = 1;
      let broken = false;
      const cacheModes: (RequestCache | undefined)[] = [];
      const loader = new window.GLTSLoader(new window.LoadingManager(), {
        fetch: async (_input, options) => {
          cacheModes.push(options?.cache);
          if (broken && failure === "fetch") return new Response("unavailable", { status: 503 });
          if (broken && failure === "compile") return new Response("const =");
          if (broken && failure === "execute") return new Response('throw new Error("broken source")');
          return new Response(`import { scene } from "@drawcall/glts"; scene.name = "v${version}"`);
        }
      });
      const live = await loader.loadAsync("/root.glts");
      broken = true;
      let phase: unknown;
      try { await loader.reload("/root.glts"); }
      catch (error) { phase = window.readErrorField(error, "phase"); }
      const preserved = live.name;
      live.dispose();
      broken = false;
      version = 2;
      const next = await loader.loadAsync("/root.glts");
      const name = next.name;
      loader.dispose();
      return { phase, preserved, name, cacheModes };
    }, failure);
    expect(result.phase).toBe(phase);
    expect(result.preserved).toBe("v1");
    expect(result.name).toBe("v2");
    expect(result.cacheModes).toEqual(["no-cache", "no-cache", "no-cache"]);
  });
}

for (const { failure, phase } of [
  { failure: "fetch", phase: "fetch" },
  { failure: "compile", phase: "transform" }
]) {
  test(`retries shared ${failure} failures and caches the successful result`, async ({ page }) => {
    await page.goto("/test-harness.html");
    const result = await page.evaluate(async (failure) => {
      let broken = true;
      const cacheModes: (RequestCache | undefined)[] = [];
      const loader = new window.GLTSLoader(new window.LoadingManager(), {
        fetch: async (_input, options) => {
          cacheModes.push(options?.cache);
          if (broken && failure === "fetch") return new Response("unavailable", { status: 503 });
          if (broken) return new Response("const =");
          return new Response('import { scene } from "@drawcall/glts"; scene.name = "recovered"');
        }
      });
      const attempts = await Promise.allSettled([
        loader.loadAsync("/retry.glts"), loader.loadAsync("/retry.glts")
      ]);
      const phases = attempts.map((result) => result.status === "rejected"
        ? window.readErrorField(result.reason, "phase") : "unexpected success");
      broken = false;
      const recovered = await loader.loadAsync("/retry.glts");
      const cached = await loader.loadAsync("/retry.glts");
      const snapshot = { phases, names: [recovered.name, cached.name], cacheModes };
      loader.dispose();
      return snapshot;
    }, failure);
    expect(result).toEqual({
      phases: [phase, phase], names: ["recovered", "recovered"], cacheModes: ["no-cache", "no-cache"]
    });
  });
}

test("reload waits for a pending load and refreshes its live result and future loads", async ({ page }) => {
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    let release: () => void = () => { throw new Error("Fetch gate not initialized"); };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => { throw new Error("Fetch signal not initialized"); };
    const requested = new Promise<void>((resolve) => { started = resolve; });
    let requests = 0;
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      fetch: async () => {
        const version = ++requests;
        if (version === 1) { started(); await gate; }
        return new Response(`import { scene } from "@drawcall/glts"; scene.name = "v${version}"`);
      }
    });
    const pending = loader.loadAsync("/pending.glts");
    await requested;
    const reload = loader.reload("/pending.glts#edit");
    release();
    const live = await pending;
    await reload;
    const future = await loader.loadAsync("/pending.glts");
    const snapshot = { live: live.name, future: future.name, requests };
    loader.dispose();
    return snapshot;
  });
  expect(result).toEqual({ live: "v2", future: "v2", requests: 2 });
});

test("invalidates inactive instances through the same path and URL modifier as loading", async ({ page }) => {
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    let version = 1;
    let requests = 0;
    const manager = new window.LoadingManager();
    manager.setURLModifier((url) => url.replace("/logical/", "/actual/"));
    const loader = new window.GLTSLoader(manager, {
      baseURL: new URL("/assets/", location.href),
      fetch: async () => {
        requests++;
        const response = new Response(`
          import { scene, onMatrixUpdateAt } from "@drawcall/glts"
          onMatrixUpdateAt(() => {})
          scene.name = "v${version}"
        `);
        Object.defineProperty(response, "url", {
          value: new URL("/actual/redirected.glts", location.href).href
        });
        return response;
      }
    }).setPath("/logical/");
    const first = await loader.loadInstancesAsync("scene.glts", 2);
    first.dispose();
    version = 2;
    await loader.reload("./scene.glts#changed");
    const idleRequests = requests;
    const second = await loader.loadInstancesAsync("scene.glts", 2);
    const redirected = await loader.loadAsync(new URL("/actual/redirected.glts", location.href));
    const snapshot = { idleRequests, requests, name: second.name, count: second.count, url: second.url };
    redirected.dispose();
    loader.dispose();
    return snapshot;
  });
  expect(result).toEqual({ idleRequests: 1, requests: 3, name: "v2", count: 2, url: new URL("/actual/scene.glts", page.url()).href });
});
