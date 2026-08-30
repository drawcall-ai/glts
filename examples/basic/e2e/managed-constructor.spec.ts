import { expect, test } from "@playwright/test";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
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

test("returns one managed constructor and shares instance resource loading", async ({
  page
}) => {
  let sourceRequests = 0;
  await page.route("**/assets/managed-tree.glts", (route) => {
    sourceRequests += 1;
    return route.fulfill({
      body: `
        import * as THREE from "three"
        import { loadingManager } from "@drawcall/glts/asset"

        export default class Tree extends THREE.Group {
          constructor() {
            super()
            this.name = "raw tree"
            this.secret = () => "authored method"
            Reflect.set(
              globalThis,
              "__managedConstructions",
              (Reflect.get(globalThis, "__managedConstructions") ?? 0) + 1,
            )
            new THREE.FileLoader(loadingManager).load(
              new URL("./managed-tree.bin", import.meta.url).href,
            )
          }
        }
      `,
      contentType: "text/plain"
    });
  });
  const requested = deferred();
  const release = deferred();
  let resourceRequests = 0;
  await page.route("**/assets/managed-tree.bin", async (route) => {
    resourceRequests += 1;
    requested.resolve();
    await release.promise;
    await route.fulfill({ body: "tree", contentType: "application/octet-stream" });
  });

  await page.goto("/test-harness.html");
  const retrieval = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    const events: string[] = [];
    const resolveURL = manager.resolveURL.bind(manager);
    const itemStart = manager.itemStart.bind(manager);
    const itemEnd = manager.itemEnd.bind(manager);
    manager.resolveURL = (url) => {
      events.push("resolve");
      return resolveURL(url);
    };
    manager.itemStart = (url) => {
      events.push("start");
      itemStart(url);
    };
    manager.itemEnd = (url) => {
      events.push("end");
      itemEnd(url);
    };

    const loader = new window.GLTSLoader(manager);
    const [FirstTree, SecondTree] = await Promise.all([
      loader.loadAsyncConstructor("/assets/managed-tree.glts"),
      loader.loadAsyncConstructor("/assets/managed-tree.glts")
    ]);
    const first = new FirstTree();
    const second = new SecondTree();
    const RetrievedWhileLive = await loader.loadAsyncConstructor(
      "/assets/managed-tree.glts"
    );
    const loadEvents = [...events];
    Reflect.set(globalThis, "__managedLoader", loader);
    Reflect.set(globalThis, "__managedFirst", first);
    Reflect.set(globalThis, "__managedSecond", second);
    return {
      constructions: Reflect.get(globalThis, "__managedConstructions"),
      constructorStable: FirstTree === SecondTree && FirstTree === RetrievedWhileLive,
      distinctRaw: first.children[0] !== second.children[0],
      distinctWrappers: first !== second,
      events: loadEvents,
      managedNotAuthored: !Reflect.has(first, "secret"),
      reachable: loader.has("/assets/managed-tree.glts")
    };
  });

  await requested.promise;
  expect(retrieval).toEqual({
    constructions: 2,
    constructorStable: true,
    distinctRaw: true,
    distinctWrappers: true,
    events: [
      "resolve",
      "start",
      "resolve",
      "start",
      "end",
      "end",
      "resolve",
      "start",
      "end"
    ],
    managedNotAuthored: true,
    reachable: true
  });
  expect({ resourceRequests, sourceRequests }).toEqual({
    resourceRequests: 1,
    sourceRequests: 1
  });

  expect(await page.evaluate(async () => {
    const first = Reflect.get(globalThis, "__managedFirst");
    const second = Reflect.get(globalThis, "__managedSecond");
    let firstReady = false;
    let secondReady = false;
    void first.ready.then(() => {
      firstReady = true;
    });
    void second.ready.then(() => {
      secondReady = true;
    });
    await Promise.resolve();
    return { firstReady, secondReady };
  })).toEqual({ firstReady: false, secondReady: false });

  release.resolve();
  await page.evaluate(async () => {
    const loader = Reflect.get(globalThis, "__managedLoader");
    const first = Reflect.get(globalThis, "__managedFirst");
    const second = Reflect.get(globalThis, "__managedSecond");
    await Promise.all([first.ready, second.ready]);
    const parent = new window.Group();
    parent.add(first);
    parent.remove(first);
    second.dispose();
    if (!loader.has("/assets/managed-tree.glts")) {
      throw new Error("Removing a wrapper must not release its root");
    }
    first.dispose();
    first.dispose();
    if (loader.has("/assets/managed-tree.glts")) {
      throw new Error("Disposing every instance should release the root");
    }
    loader.dispose();
  });
});

test("loadAsync uses one constructor-loading lifecycle", async ({ page }) => {
  await page.route("**/assets/ordinary-load.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      export default class Ordinary extends THREE.Group {
        constructor() {
          super()
          Reflect.set(
            globalThis,
            "__ordinaryConstructions",
            (Reflect.get(globalThis, "__ordinaryConstructions") ?? 0) + 1,
          )
        }
      }
    `,
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    let resolutions = 0;
    let starts = 0;
    let ends = 0;
    const resolveURL = manager.resolveURL.bind(manager);
    const itemStart = manager.itemStart.bind(manager);
    const itemEnd = manager.itemEnd.bind(manager);
    manager.resolveURL = (url) => {
      resolutions += 1;
      return resolveURL(url);
    };
    manager.itemStart = (url) => {
      starts += 1;
      itemStart(url);
    };
    manager.itemEnd = (url) => {
      ends += 1;
      itemEnd(url);
    };

    const loader = new window.GLTSLoader(manager);
    const asset = await loader.loadAsync("/assets/ordinary-load.glts");
    const outcome = {
      constructions: Reflect.get(globalThis, "__ordinaryConstructions"),
      ends,
      resolutions,
      starts
    };
    asset.dispose();
    loader.dispose();
    return outcome;
  });

  expect(result).toEqual({ constructions: 1, ends: 1, resolutions: 1, starts: 1 });
});

test("reloads live managed instances without changing wrapper or constructor", async ({
  page
}) => {
  const sources = ["before", "after"];
  let sourceIndex = 0;
  await page.route("**/assets/reloadable-constructor.glts", (route) => {
    const name = sources[sourceIndex];
    sourceIndex += 1;
    if (!name) {
      throw new Error("Reloadable source was requested too many times");
    }

    return route.fulfill({
      body: `
        import * as THREE from "three"
        export default class Revision extends THREE.Group {
          constructor() {
            super()
            this.name = ${JSON.stringify(name)}
          }

          dispose() {
            const key = ${JSON.stringify(`${name}Disposals`)}
            Reflect.set(globalThis, key, (Reflect.get(globalThis, key) ?? 0) + 1)
          }
        }
      `,
      contentType: "text/plain"
    });
  });

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const Constructor = await loader.loadAsyncConstructor(
      "/assets/reloadable-constructor.glts"
    );
    const first = new Constructor();
    await first.ready;
    const firstRaw = first.children[0];
    const parent = new window.Group();
    parent.add(first);

    await loader.reload("/assets/reloadable-constructor.glts");
    const RetrievedAgain = await loader.loadAsyncConstructor(
      "/assets/reloadable-constructor.glts"
    );
    const second = new Constructor();
    await second.ready;

    const outcome = {
      constructorStable: Constructor === RetrievedAgain,
      firstRawDisposed: Reflect.get(globalThis, "beforeDisposals"),
      firstRawReplaced: first.children[0] !== firstRaw,
      firstRevision: first.children[0]?.name,
      futureRevision: second.children[0]?.name,
      wrapperStable: parent.children[0] === first
    };
    first.dispose();
    second.dispose();
    loader.dispose();
    return outcome;
  });

  expect(result).toEqual({
    constructorStable: true,
    firstRawDisposed: 1,
    firstRawReplaced: true,
    firstRevision: "after",
    futureRevision: "after",
    wrapperStable: true
  });
});

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
