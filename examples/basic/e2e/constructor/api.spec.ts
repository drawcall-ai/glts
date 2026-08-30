import { expect, test } from "@playwright/test";

import { deferred } from "../deferred.js";
import { routeGLTS, routeGLTSRevisions } from "../routes.js";

test("returns one managed constructor and shares instance resource loading", async ({
  page
}) => {
  const sourceRevisions = await routeGLTSRevisions(
    page,
    "**/assets/managed-tree.glts",
    [`
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
      `]
  );
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
  expect({ resourceRequests, sourceRequests: sourceRevisions.requests }).toEqual({
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
  await routeGLTS(page, "**/assets/ordinary-load.glts", `
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
    `);

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
  const sources = ["before", "after"].map((name) => `
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
      `);
  await routeGLTSRevisions(
    page,
    "**/assets/reloadable-constructor.glts",
    sources
  );

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
