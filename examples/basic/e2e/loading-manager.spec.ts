import { expect, test } from "@playwright/test";
import type { GLTSAsset } from "@drawcall/glts";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function assetSource(name: string, child?: string): string {
  const childImport = child ? `import Child from ${JSON.stringify(child)}` : "";
  const childMount = child ? "this.add(new Child())" : "";

  return `
    import * as THREE from "three"
    ${childImport}
    export default class Asset extends THREE.Group {
      constructor() {
        super()
        this.name = ${JSON.stringify(name)}
        ${childMount}
      }
    }
  `;
}

function deferred(): Deferred {
  let release = (): void => {
    throw new Error("Deferred promise was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

test("waits for resources started by a nested GLTS constructor", async ({ page }) => {
  await page.route("**/assets/tracked-root.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import Child from "./tracked-child.glts"

      export default class Root extends THREE.Group {
        constructor() {
          super()
          this.add(new Child())
        }
      }
    `,
    contentType: "text/plain"
  }));
  await page.route("**/assets/tracked-child.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import { loadingManager } from "@drawcall/glts/asset"

      export default class Child extends THREE.Group {
        constructor() {
          super()
          Reflect.set(globalThis, "__gltsNestedConstructed", true)
          new THREE.TextureLoader(loadingManager).load(
            new URL("./tracked-leaf.svg", import.meta.url).href,
          )
        }
      }
    `,
    contentType: "text/plain"
  }));
  const requested = deferred();
  const release = deferred();
  await page.route("**/assets/tracked-leaf.svg", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      contentType: "image/svg+xml"
    });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader();
    Reflect.set(globalThis, "__gltsTrackedLoader", loader);
    Reflect.set(globalThis, "__gltsTrackedComplete", false);
    void loader.loadAsync("/assets/tracked-root.glts").then((asset) => {
      Reflect.set(globalThis, "__gltsTrackedAsset", asset);
      Reflect.set(globalThis, "__gltsTrackedComplete", true);
    });
  });

  await requested.promise;
  expect(await page.evaluate(() => ({
    complete: Reflect.get(globalThis, "__gltsTrackedComplete"),
    nestedConstructed: Reflect.get(globalThis, "__gltsNestedConstructed")
  }))).toEqual({ complete: false, nestedConstructed: true });

  release.resolve();
  await page.waitForFunction(() => Reflect.get(globalThis, "__gltsTrackedComplete") === true);
  const childCount = await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__gltsTrackedLoader");
    const asset = Reflect.get(globalThis, "__gltsTrackedAsset");
    const count = asset.scene.children[0].children[0].children.length;
    asset.dispose();
    loader.dispose();
    return count;
  });
  expect(childCount).toBe(1);
});

test("reports constructor-started resource failures to promise and callback loads", async ({
  page
}) => {
  await page.route(/.*\/assets\/(?:promise|callback)-resource\.glts/, (route) => {
    const kind = route.request().url().includes("promise") ? "promise" : "callback";
    return route.fulfill({
      body: `
        import * as THREE from "three"
        import { loadingManager } from "@drawcall/glts/asset"

        export default class BrokenResource extends THREE.Group {
          constructor() {
            super()
            new THREE.TextureLoader(loadingManager).load(
              new URL("./missing-${kind}.svg", import.meta.url).href,
            )
          }
        }
      `,
      contentType: "text/plain"
    });
  });
  await page.route(/.*\/assets\/missing-(?:promise|callback)\.svg/, (route) =>
    route.abort("failed")
  );

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const promiseLoader = new window.GLTSLoader();
    let promisePhase: unknown;
    try {
      await promiseLoader.loadAsync("/assets/promise-resource.glts");
    } catch (error) {
      promisePhase = typeof error === "object" && error !== null
        ? Reflect.get(error, "phase")
        : undefined;
    } finally {
      promiseLoader.dispose();
    }

    const callbackLoader = new window.GLTSLoader();
    const callback = await new Promise<string>((resolve) => {
      callbackLoader.load(
        "/assets/callback-resource.glts",
        () => resolve("load"),
        undefined,
        (error) => resolve(
          typeof error === "object" && error !== null
            ? String(Reflect.get(error, "phase"))
            : "unknown"
        )
      );
    });
    callbackLoader.dispose();
    return { callback, promisePhase };
  });

  expect(result).toEqual({ callback: "resource", promisePhase: "resource" });
});

test("shares constructor resource state within a loader and isolates runtimes", async ({
  page
}) => {
  await page.route(/.*\/assets\/isolated-(?:first|shared|second)\.glts/, (route) => {
    const first = route.request().url().includes("first");
    return route.fulfill({
      body: `
        import * as THREE from "three"
        import { loadingManager } from "@drawcall/glts/asset"

        export default class Isolated extends THREE.Group {
          constructor() {
            super()
            const managers = Reflect.get(globalThis, "__gltsRuntimeManagers") ?? []
            managers.push(loadingManager)
            Reflect.set(globalThis, "__gltsRuntimeManagers", managers)
            ${first ? `new THREE.FileLoader(loadingManager).load(
              new URL("./isolated-slow.bin", import.meta.url).href,
            )` : ""}
          }
        }
      `,
      contentType: "text/plain"
    });
  });
  const requested = deferred();
  const release = deferred();
  await page.route("**/assets/isolated-slow.bin", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ body: "done", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader();
    Reflect.set(globalThis, "__gltsFirstLoader", loader);
    Reflect.set(globalThis, "__gltsFirstComplete", false);
    void loader.loadAsync("/assets/isolated-first.glts").then((asset) => {
      Reflect.set(globalThis, "__gltsFirstAsset", asset);
      Reflect.set(globalThis, "__gltsFirstComplete", true);
    });
  });
  await requested.promise;

  await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__gltsFirstLoader");
    Reflect.set(globalThis, "__gltsSharedComplete", false);
    void loader.loadAsync("/assets/isolated-shared.glts").then((asset: GLTSAsset) => {
      Reflect.set(globalThis, "__gltsSharedAsset", asset);
      Reflect.set(globalThis, "__gltsSharedComplete", true);
    });
  });
  await page.waitForFunction(() =>
    Reflect.get(globalThis, "__gltsRuntimeManagers")?.length === 2
  );

  const independent = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/isolated-second.glts");
    const managers = Reflect.get(globalThis, "__gltsRuntimeManagers");
    const result = {
      distinctManagers: managers[0] !== managers[2],
      firstComplete: Reflect.get(globalThis, "__gltsFirstComplete"),
      sharedComplete: Reflect.get(globalThis, "__gltsSharedComplete"),
      sharedManager: managers[0] === managers[1]
    };
    asset.dispose();
    loader.dispose();
    return result;
  });
  expect(independent).toEqual({
    distinctManagers: true,
    firstComplete: false,
    sharedComplete: false,
    sharedManager: true
  });

  release.resolve();
  await page.waitForFunction(() =>
    Reflect.get(globalThis, "__gltsFirstComplete") === true
    && Reflect.get(globalThis, "__gltsSharedComplete") === true
  );
  await page.evaluate(() => {
    Reflect.get(globalThis, "__gltsFirstAsset").dispose();
    Reflect.get(globalThis, "__gltsSharedAsset").dispose();
    Reflect.get(globalThis, "__gltsFirstLoader").dispose();
  });
});

test("tracks the same FileLoader URL independently across runtimes", async ({ page }) => {
  await page.route("**/assets/shared-file-root.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import { loadingManager } from "@drawcall/glts/asset"

      export default class SharedFile extends THREE.Group {
        constructor() {
          super()
          Reflect.set(
            globalThis,
            "__gltsSameConstructions",
            (Reflect.get(globalThis, "__gltsSameConstructions") ?? 0) + 1,
          )
          new THREE.FileLoader(loadingManager).load(
            new URL("./same-runtime-file.bin#payload", import.meta.url).href,
          )
        }
      }
    `,
    contentType: "text/plain"
  }));
  const requested: [Deferred, Deferred] = [deferred(), deferred()];
  const release: [Deferred, Deferred] = [deferred(), deferred()];
  let resourceRequests = 0;
  await page.route("**/assets/same-runtime-file.bin*", async (route) => {
    const request = requested[resourceRequests];
    const completion = release[resourceRequests];
    resourceRequests += 1;
    if (!request || !completion) {
      throw new Error("Shared file was requested more than twice");
    }

    request.resolve();
    await completion.promise;
    await route.fulfill({ body: "done", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader();
    Reflect.set(globalThis, "__gltsSameFirstLoader", loader);
    Reflect.set(globalThis, "__gltsSameFirstStatus", "pending");
    void loader.loadAsync("/assets/shared-file-root.glts").then((asset) => {
      Reflect.set(globalThis, "__gltsSameFirstAsset", asset);
      Reflect.set(globalThis, "__gltsSameFirstStatus", "resolved");
    });
  });
  await requested[0].promise;

  await page.evaluate(() => {
    const loader = Reflect.get(globalThis, "__gltsSameFirstLoader");
    Reflect.set(globalThis, "__gltsSameSharedStatus", "pending");
    void loader.loadAsync("/assets/shared-file-root.glts").then((asset: GLTSAsset) => {
      Reflect.set(globalThis, "__gltsSameSharedAsset", asset);
      Reflect.set(globalThis, "__gltsSameSharedStatus", "resolved");
    });
  });
  await page.waitForFunction(() =>
    Reflect.get(globalThis, "__gltsSameConstructions") === 2
  );

  await page.evaluate(() => {
    const loader = new window.GLTSLoader();
    Reflect.set(globalThis, "__gltsSameSecondLoader", loader);
    Reflect.set(globalThis, "__gltsSameSecondStatus", "pending");
    void loader.loadAsync("/assets/shared-file-root.glts").then((asset) => {
      Reflect.set(globalThis, "__gltsSameSecondAsset", asset);
      Reflect.set(globalThis, "__gltsSameSecondStatus", "resolved");
    });
  });
  await requested[1].promise;

  expect(await page.evaluate(() => ({
    first: Reflect.get(globalThis, "__gltsSameFirstStatus"),
    shared: Reflect.get(globalThis, "__gltsSameSharedStatus"),
    second: Reflect.get(globalThis, "__gltsSameSecondStatus")
  }))).toEqual({ first: "pending", second: "pending", shared: "pending" });

  release[1].resolve();
  await page.waitForFunction(() =>
    Reflect.get(globalThis, "__gltsSameSecondStatus") === "resolved"
  );
  expect(await page.evaluate(() =>
    [
      Reflect.get(globalThis, "__gltsSameFirstStatus"),
      Reflect.get(globalThis, "__gltsSameSharedStatus")
    ]
  )).toEqual(["pending", "pending"]);

  release[0].resolve();
  await page.waitForFunction(() =>
    Reflect.get(globalThis, "__gltsSameFirstStatus") === "resolved"
    && Reflect.get(globalThis, "__gltsSameSharedStatus") === "resolved"
  );
  await page.evaluate(() => {
    Reflect.get(globalThis, "__gltsSameFirstAsset").dispose();
    Reflect.get(globalThis, "__gltsSameSharedAsset").dispose();
    Reflect.get(globalThis, "__gltsSameSecondAsset").dispose();
    Reflect.get(globalThis, "__gltsSameFirstLoader").dispose();
    Reflect.get(globalThis, "__gltsSameSecondLoader").dispose();
  });
  expect(resourceRequests).toBe(2);
});

test("does not turn reload into a resource completion boundary", async ({ page }) => {
  const sources = [
    assetSource("before"),
    `
      import * as THREE from "three"
      import { loadingManager } from "@drawcall/glts/asset"

      export default class Reloaded extends THREE.Group {
        constructor() {
          super()
          this.name = "after"
          Reflect.set(globalThis, "__gltsReloadConstructed", true)
          new THREE.FileLoader(loadingManager).load(
            new URL("./reload-slow.bin", import.meta.url).href,
          )
        }
      }
    `
  ];
  let requests = 0;
  await page.route("**/assets/reload-resource.glts", (route) => {
    const source = sources[requests];
    requests += 1;
    if (!source) {
      throw new Error("Reload resource asset was fetched more than twice");
    }
    return route.fulfill({ body: source, contentType: "text/plain" });
  });
  const requested = deferred();
  const release = deferred();
  await page.route("**/assets/reload-slow.bin", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ body: "done", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/reload-resource.glts");
    Reflect.set(globalThis, "__gltsReloadLoader", loader);
    Reflect.set(globalThis, "__gltsReloadAsset", asset);
    Reflect.set(globalThis, "__gltsReloadComplete", false);
    void loader.reload("/assets/reload-resource.glts").then(() => {
      Reflect.set(globalThis, "__gltsReloadComplete", true);
    });
  });
  await requested.promise;
  await page.waitForFunction(() => Reflect.get(globalThis, "__gltsReloadComplete") === true);
  expect(await page.evaluate(() => ({
    constructed: Reflect.get(globalThis, "__gltsReloadConstructed"),
    name: Reflect.get(globalThis, "__gltsReloadAsset").scene.children[0].name
  }))).toEqual({ constructed: true, name: "after" });

  release.resolve();
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    Reflect.get(globalThis, "__gltsReloadAsset").dispose();
    Reflect.get(globalThis, "__gltsReloadLoader").dispose();
  });
});

test("rejects a pending root when its loader is disposed", async ({ page }) => {
  await page.route("**/assets/disposed-loading.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import { loadingManager } from "@drawcall/glts/asset"

      export default class DisposedLoading extends THREE.Group {
        constructor() {
          super()
          new THREE.FileLoader(loadingManager).load(
            new URL("./disposed-slow.bin", import.meta.url).href,
          )
        }
      }
    `,
    contentType: "text/plain"
  }));
  const requested = deferred();
  const release = deferred();
  await page.route("**/assets/disposed-slow.bin", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ body: "done", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  await page.evaluate(() => {
    const loader = new window.GLTSLoader();
    Reflect.set(globalThis, "__gltsDisposedLoader", loader);
    Reflect.set(globalThis, "__gltsDisposedOutcome", { status: "pending" });
    void loader.loadAsync("/assets/disposed-loading.glts").then(
      () => Reflect.set(globalThis, "__gltsDisposedOutcome", { status: "resolved" }),
      (error) => Reflect.set(globalThis, "__gltsDisposedOutcome", {
        phase: typeof error === "object" && error !== null
          ? Reflect.get(error, "phase")
          : undefined,
        status: "rejected"
      })
    );
  });
  await requested.promise;
  await page.evaluate(() => {
    Reflect.get(globalThis, "__gltsDisposedLoader").dispose();
  });
  release.resolve();
  await page.waitForFunction(() =>
    Reflect.get(globalThis, "__gltsDisposedOutcome").status !== "pending"
  );

  expect(await page.evaluate(() =>
    Reflect.get(globalThis, "__gltsDisposedOutcome")
  )).toEqual({ phase: "resolve", status: "rejected" });
});
