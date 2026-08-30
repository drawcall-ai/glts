import { expect, test } from "@playwright/test";

import { deferred } from "../deferred.js";

test("cleans up failed, early-disposed, and loader-disposed instances", async ({ page }) => {
  await page.route("**/assets/failed-constructor-resource.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import { loadingManager } from "@drawcall/glts/asset"
      export default class Failed extends THREE.Group {
        constructor() {
          super()
          new THREE.FileLoader(loadingManager).load(
            new URL("./missing-managed.bin", import.meta.url).href,
          )
        }

        dispose() {
          Reflect.set(globalThis, "__failedDisposed", true)
        }
      }
    `,
    contentType: "text/plain"
  }));
  await page.route("**/assets/missing-managed.bin", (route) => route.abort("failed"));
  await page.route("**/assets/pending-constructor.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import { loadingManager } from "@drawcall/glts/asset"
      export default class Pending extends THREE.Group {
        constructor() {
          super()
          new THREE.FileLoader(loadingManager).load(
            new URL("./pending-managed.bin", import.meta.url).href,
          )
        }

        dispose() {
          Reflect.set(
            globalThis,
            "__pendingDisposals",
            (Reflect.get(globalThis, "__pendingDisposals") ?? 0) + 1,
          )
        }
      }
    `,
    contentType: "text/plain"
  }));
  const requested = deferred();
  const release = deferred();
  await page.route("**/assets/pending-managed.bin", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ body: "done", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  const failed = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const Constructor = await loader.loadAsyncConstructor(
      "/assets/failed-constructor-resource.glts"
    );
    const instance = new Constructor();
    let phase: unknown;
    try {
      await instance.ready;
    } catch (error) {
      phase = typeof error === "object" && error !== null
        ? Reflect.get(error, "phase")
        : undefined;
    }
    const outcome = {
      disposed: Reflect.get(globalThis, "__failedDisposed"),
      phase,
      reachable: loader.has("/assets/failed-constructor-resource.glts")
    };
    loader.dispose();
    return outcome;
  });
  expect(failed).toEqual({ disposed: true, phase: "resource", reachable: false });

  await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const Constructor = await loader.loadAsyncConstructor("/assets/pending-constructor.glts");
    const first = new Constructor();
    const second = new Constructor();
    const parent = new window.Group();
    parent.add(first);
    Reflect.set(globalThis, "__pendingLoader", loader);
    Reflect.set(globalThis, "__pendingConstructor", Constructor);
    Reflect.set(globalThis, "__pendingFirst", first);
    Reflect.set(globalThis, "__pendingSecond", second);
    Reflect.set(globalThis, "__pendingParent", parent);
  });
  await requested.promise;

  const disposed = await page.evaluate(async () => {
    const loader = Reflect.get(globalThis, "__pendingLoader");
    const Constructor = Reflect.get(globalThis, "__pendingConstructor");
    const first = Reflect.get(globalThis, "__pendingFirst");
    const second = Reflect.get(globalThis, "__pendingSecond");
    const parent = Reflect.get(globalThis, "__pendingParent");
    first.dispose();
    first.dispose();
    let earlyPhase: unknown;
    try {
      await first.ready;
    } catch (error) {
      earlyPhase = typeof error === "object" && error !== null
        ? Reflect.get(error, "phase")
        : undefined;
    }

    loader.dispose();
    let loaderPhase: unknown;
    try {
      await second.ready;
    } catch (error) {
      loaderPhase = typeof error === "object" && error !== null
        ? Reflect.get(error, "phase")
        : undefined;
    }

    let retainedConstructorPhase: unknown;
    try {
      new Constructor();
    } catch (error) {
      retainedConstructorPhase = typeof error === "object" && error !== null
        ? Reflect.get(error, "phase")
        : undefined;
    }

    return {
      disposedStillParented: parent.children.includes(first),
      earlyPhase,
      loaderPhase,
      pendingDisposals: Reflect.get(globalThis, "__pendingDisposals"),
      reachable: loader.has("/assets/pending-constructor.glts"),
      retainedConstructorPhase
    };
  });
  expect(disposed).toEqual({
    disposedStillParented: true,
    earlyPhase: "dispose",
    loaderPhase: "dispose",
    pendingDisposals: 2,
    reachable: false,
    retainedConstructorPhase: "resolve"
  });

  release.resolve();
});

test("rejects disposal after runtime idle but before public readiness", async ({ page }) => {
  await page.route("**/assets/readiness-race.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import { loadingManager } from "@drawcall/glts/asset"
      export default class ReadinessRace extends THREE.Group {
        constructor() {
          super()
          loadingManager.itemStart("glts://readiness-race")
          Reflect.set(globalThis, "__finishReadinessRace", () => {
            loadingManager.itemEnd("glts://readiness-race")
          })
        }
      }
    `,
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const phase = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const Constructor = await loader.loadAsyncConstructor("/assets/readiness-race.glts");
    const instance = new Constructor();
    Reflect.apply(Reflect.get(globalThis, "__finishReadinessRace"), undefined, []);
    await Promise.resolve();
    instance.dispose();
    try {
      await instance.ready;
      return "resolved";
    } catch (error) {
      return typeof error === "object" && error !== null
        ? Reflect.get(error, "phase")
        : "unknown";
    } finally {
      loader.dispose();
    }
  });

  expect(phase).toBe("dispose");
});

test("owns nested roots and leaks nothing after synchronous construction failure", async ({
  page
}) => {
  await page.route("**/assets/managed-parent.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import Child from "./managed-child.glts"
      export default class Parent extends THREE.Group {
        constructor() {
          super()
          this.add(new Child())
        }

        dispose() {
          Reflect.set(globalThis, "__managedParentDisposed", true)
        }
      }
    `,
    contentType: "text/plain"
  }));
  await page.route("**/assets/managed-child.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      export default class Child extends THREE.Group {
        dispose() {
          Reflect.set(globalThis, "__managedChildDisposed", true)
        }
      }
    `,
    contentType: "text/plain"
  }));
  await page.route("**/assets/broken-constructor.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import Child from "./rollback-child.glts"
      export default class Broken extends THREE.Group {
        constructor() {
          super()
          this.add(new Child())
          throw new Error("broken construction")
        }
      }
    `,
    contentType: "text/plain"
  }));
  await page.route("**/assets/rollback-child.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      export default class RollbackChild extends THREE.Group {
        dispose() {
          Reflect.set(
            globalThis,
            "__rollbackChildDisposals",
            (Reflect.get(globalThis, "__rollbackChildDisposals") ?? 0) + 1,
          )
        }
      }
    `,
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const outcome = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const Parent = await loader.loadAsyncConstructor("/assets/managed-parent.glts");
    const parent = new Parent();
    await parent.ready;
    const nestedReachable = loader.has("/assets/managed-child.glts");
    parent.dispose();

    const Broken = await loader.loadAsyncConstructor("/assets/broken-constructor.glts");
    let constructionPhase: unknown;
    try {
      new Broken();
    } catch (error) {
      constructionPhase = typeof error === "object" && error !== null
        ? Reflect.get(error, "phase")
        : undefined;
    }

    const rollbackDisposalsBeforeLoaderDispose = Reflect.get(
      globalThis,
      "__rollbackChildDisposals"
    );
    const failedRootReachable = loader.has("/assets/broken-constructor.glts");
    loader.dispose();
    return {
      childDisposed: Reflect.get(globalThis, "__managedChildDisposed"),
      constructionPhase,
      failedRootReachable,
      nestedReachable,
      parentDisposed: Reflect.get(globalThis, "__managedParentDisposed"),
      parentReachable: loader.has("/assets/managed-parent.glts"),
      rollbackDisposalsAfterLoaderDispose: Reflect.get(
        globalThis,
        "__rollbackChildDisposals"
      ),
      rollbackDisposalsBeforeLoaderDispose
    };
  });

  expect(outcome).toEqual({
    childDisposed: true,
    constructionPhase: "construct",
    failedRootReachable: false,
    nestedReachable: true,
    parentDisposed: true,
    parentReachable: false,
    rollbackDisposalsAfterLoaderDispose: 1,
    rollbackDisposalsBeforeLoaderDispose: 1
  });
});
