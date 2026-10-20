import { expect, test } from "@playwright/test";

import { fulfillScript, routeScript } from "./routes.js";

test("returns the authored scene and runs contextual lifecycle hooks", async ({ page }) => {
  await routeScript(page, "**/assets/context.glts", `
    import * as THREE from "three"
    import { isPreview, onDispose, onFrame, scene } from "@drawcall/glts"

    scene.name = "context scene"
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    if (isPreview) {
      scene.add(new THREE.AmbientLight())
    }
    onFrame((delta) => {
      scene.userData.elapsed = (scene.userData.elapsed ?? 0) + delta
    })
    onDispose(() => {
      globalThis.__contextDisposals = (globalThis.__contextDisposals ?? 0) + 1
    })
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager(), { isPreview: true });
    const node = await loader.loadAsync(new URL("/assets/context.glts", location.href));
    node.update(0.25);
    const clone = node.clone();
    let lights = 0;
    node.traverse((object) => {
      if (Reflect.get(object, "isLight") === true) lights += 1;
    });
    const snapshot = {
      cloneIsScene: clone instanceof window.Scene,
      cloneManaged: Object.hasOwn(clone, "url") || Object.hasOwn(clone, "update"),
      elapsed: node.userData.elapsed,
      isScene: node instanceof window.Scene,
      lights,
      name: node.name,
      url: node.url
    };
    node.dispose();
    const disposals = Reflect.get(globalThis, "__contextDisposals");
    loader.dispose();
    return { ...snapshot, disposals };
  });

  expect(result).toEqual({
    cloneIsScene: true,
    cloneManaged: false,
    disposals: 1,
    elapsed: 0.25,
    isScene: true,
    lights: 1,
    name: "context scene",
    url: new URL("/assets/context.glts", page.url()).href
  });
});

test("enables preview only for a root scene across recursion and reload, never for instances", async ({ page }) => {
  await routeScript(page, "**/assets/parent.glts", `
    import { gltsLoader, isPreview, scene } from "@drawcall/glts"
    globalThis.__parentContextLoader = gltsLoader
    scene.userData.preview = isPreview
    const child = await gltsLoader.loadAsync(new URL("./child.glts", import.meta.url))
    scene.add(child)
  `);
  await routeScript(page, "**/assets/child.glts", `
    import { gltsLoader, isPreview, onDispose, scene } from "@drawcall/glts"
    scene.name = "child"
    scene.userData.preview = isPreview
    scene.userData.scopedLoader = gltsLoader !== globalThis.__parentContextLoader
    const grandchild = await gltsLoader.loadAsync(new URL("./grandchild.glts", import.meta.url))
    scene.add(grandchild)
    onDispose(() => { globalThis.__childDisposed = true })
  `);
  await routeScript(page, "**/assets/grandchild.glts", `
    import { isPreview, scene } from "@drawcall/glts"
    scene.name = "grandchild"
    scene.userData.preview = isPreview
  `);
  await routeScript(page, "**/assets/preview-instances.glts", `
    import { isPreview, onMatrixUpdateAt, scene } from "@drawcall/glts"
    onMatrixUpdateAt(() => {})
    scene.userData.preview = isPreview
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    const completed: string[] = [];
    manager.onProgress = (url) => completed.push(new URL(url).pathname);
    const loader = new window.GLTSLoader(manager, { isPreview: true });
    const parent = await loader.loadAsync("/assets/parent.glts");
    const child = parent.children[0];
    if (!child) throw new Error("Child was not loaded");
    const grandchild = child.children[0];
    if (!grandchild) throw new Error("Grandchild was not loaded");
    const initial = {
      childName: child.name,
      childPreview: child.userData.preview,
      grandchildPreview: grandchild.userData.preview,
      completed: completed.slice().sort(),
      parentPreview: parent.userData.preview,
      scopedLoader: child.userData.scopedLoader
    };
    await loader.reload("/assets/child.glts");
    const reloadedGrandchild = child.children[0];
    if (!reloadedGrandchild) throw new Error("Grandchild was not reloaded");
    const reloaded = {
      childPreview: child.userData.preview,
      grandchildPreview: reloadedGrandchild.userData.preview
    };
    parent.dispose();
    const childDisposed = Reflect.get(globalThis, "__childDisposed");
    const instances = await loader.loadInstancesAsync("/assets/preview-instances.glts", 2);
    const instancesPreview = instances.userData.preview;
    loader.dispose();
    return { ...initial, childDisposed, instancesPreview, reloaded };
  });

  expect(result).toEqual({
    childDisposed: true,
    childName: "child",
    childPreview: false,
    grandchildPreview: false,
    instancesPreview: false,
    completed: ["/assets/child.glts", "/assets/grandchild.glts", "/assets/parent.glts"],
    parentPreview: true,
    reloaded: {
      childPreview: false,
      grandchildPreview: false
    },
    scopedLoader: true
  });
});

test("resolves nested URLs against their script while reading current host request configuration", async ({ page }) => {
  const requests: { path: string; header: string | undefined }[] = [];
  await page.route(/\.glts\?mapped$/, (route) => {
    const url = new URL(route.request().url());
    requests.push({ path: url.pathname + url.search, header: route.request().headers()["x-context"] });
    return fulfillScript(route, url.pathname.endsWith("parent.glts") ? `
      import { gltsLoader, scene } from "@drawcall/glts";
      globalThis.__contextHost.setRequestHeader({ "x-context": "child" });
      scene.add(await gltsLoader.loadAsync("child.glts"));
      scene.userData.contextualHost = "setPath" in gltsLoader;
    ` : `import { scene } from "@drawcall/glts"; scene.name = "child";`);
  });

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const resolved: string[] = [];
    const manager = new window.LoadingManager();
    manager.setURLModifier((url) => {
      resolved.push(url);
      return `${url}?mapped`;
    });
    const loader = new window.GLTSLoader(manager);
    Reflect.set(globalThis, "__contextHost", loader);
    loader.setPath("host/");
    loader.setRequestHeader({ "x-context": "parent" });
    try {
      const node = await loader.loadAsync("parent.glts");
      return { resolved, child: node.children[0]?.name, contextualHost: node.userData.contextualHost };
    } finally {
      loader.dispose();
    }
  });
  expect(result).toEqual({
    resolved: ["host/parent.glts", "child.glts"],
    child: "child",
    contextualHost: false
  });
  expect(requests).toEqual([
    { path: "/host/parent.glts?mapped", header: "parent" },
    { path: "/host/child.glts?mapped", header: "child" }
  ]);
});

test("releases script state, context, and scene after disposal", async ({ page }) => {
  await routeScript(page, "**/assets/retained.glts", `
    import { getGLTSContext, onFrame, scene } from "@drawcall/glts"

    const state = { elapsed: 0 }
    globalThis.__retainedState = [state, getGLTSContext(), scene].map(value => new WeakRef(value))
    function advance(delta) {
      state.elapsed += delta
    }
    onFrame(advance)
    scene.name = "retained"
  `);

  await page.goto("/test-harness.html");
  await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadAsync(new URL("/assets/retained.glts", location.href));
    node.update(0.25);
    node.dispose();
    loader.dispose();
  });

  // Evaluated modules live as long as the page, so their top-level bindings
  // must not hold script state.
  const session = await page.context().newCDPSession(page);
  await session.send("HeapProfiler.collectGarbage");
  const retained = await page.evaluate(() => {
    const references: unknown = Reflect.get(globalThis, "__retainedState");
    if (!Array.isArray(references)) throw new Error("Script did not capture its state");
    return references.map((reference: unknown) => {
      if (!(reference instanceof WeakRef)) throw new Error("Expected a weak reference");
      return reference.deref() !== undefined;
    });
  });
  expect(retained).toEqual([false, false, false]);
});

test("releases nested scenes, instances, and helper imports across load and dispose cycles", async ({ page }) => {
  const script = (nested: string) => `
    import { getGLTSContext, gltsLoader, onDispose, onFrame, onMatrixUpdateAt, scene } from "@drawcall/glts"
    import { Pass } from "three/addons/postprocessing/Pass.js"
    import { settle, track } from "./track.ts"

    const state = { frames: 0, matrices: [] }
    await settle()
    track(state, getGLTSContext(), scene)
    onFrame(() => { state.frames += 1 })
    onDispose(() => { state.frames = -1 })
    ${nested}
  `;
  const sources: Record<string, string> = {
    "/assets/leak/parent.glts": script(`
      scene.add(await gltsLoader.loadAsync("./child.glts"))
      scene.add(await gltsLoader.loadInstancesAsync("./instances.glts", 2))
      scene.rendering.effects.push(() => {
        const pass = new (class extends Pass { render() {} })()
        track(pass)
        return pass
      })
    `),
    "/assets/leak/child.glts": script(""),
    "/assets/leak/instances.glts": script("onMatrixUpdateAt((index, matrix) => { state.matrices[index] = matrix })"),
    "/assets/leak/failing-parent.glts": script(`scene.add(await gltsLoader.loadAsync("./failing.glts"))`),
    "/assets/leak/failing.glts": script(`throw new Error("expected failure")`),
    "/assets/leak/mesh.glts": `
      import * as THREE from "three"
      import { getGLTSContext, scene } from "@drawcall/glts"
      import { track } from "./track.ts"

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
      scene.add(mesh)
      track(mesh, getGLTSContext(), scene)
    `,
    "/assets/leak/track.ts": `
      export async function settle(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      export function track(...values: object[]): void {
        const references: WeakRef<object>[] = Reflect.get(globalThis, "__leakReferences") ?? []
        Reflect.set(globalThis, "__leakReferences", references)
        references.push(...values.map((value) => new WeakRef(value)))
      }
    `,
  };
  await page.route("**/assets/leak/*", (route) => {
    const source = sources[new URL(route.request().url()).pathname];
    return source === undefined ? route.fulfill({ status: 404 }) : fulfillScript(route, source);
  });

  await page.goto("/test-harness.html");
  await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const renderer = new window.WebGLRenderer({
      canvas: document.createElement("canvas"),
      ...window.GLTSRenderer.parameters
    });
    renderer.setSize(8, 8, false);
    const gltsRenderer = new window.GLTSRenderer(renderer);
    const camera = new window.PerspectiveCamera();
    // Kept alive, so their caches and history must not hold disposed scenes.
    Reflect.set(globalThis, "__leakLoader", loader);
    Reflect.set(globalThis, "__leakRenderer", gltsRenderer);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const node = await loader.loadAsync("/assets/leak/parent.glts");
      node.update(0.25);
      await loader.reload("/assets/leak/parent.glts");
      gltsRenderer.render(node, camera);
      node.dispose();

      const failed = await loader.loadAsync("/assets/leak/failing-parent.glts").then(() => false, () => true);
      if (!failed) throw new Error("Expected the failing nested load to fail");

      const instances = await loader.loadInstancesAsync("/assets/leak/mesh.glts", 3);
      instances.setMatrixAt(1, new window.Matrix4().makeTranslation(1, 0, 0));
      instances.dispose();
    }
  });

  const session = await page.context().newCDPSession(page);
  await session.send("HeapProfiler.collectGarbage");
  const retained = await page.evaluate(() => {
    const references: unknown = Reflect.get(globalThis, "__leakReferences");
    if (!Array.isArray(references)) throw new Error("Scripts did not capture their state");
    Reflect.get(globalThis, "__leakLoader").dispose();
    Reflect.get(globalThis, "__leakRenderer").dispose();
    return references.map((reference: unknown) => {
      if (!(reference instanceof WeakRef)) throw new Error("Expected a weak reference");
      return reference.deref() !== undefined;
    });
  });
  // Per cycle: state, context, and scene of three scripts loaded and then reloaded, of a failing script and
  // its parent, and of an automatically instanced mesh's script, plus one effect pass.
  expect(retained).toEqual(Array(4 * (3 * 3 * 2 + 3 * 2 + 3 + 1)).fill(false));
});

test("host modules see the calling execution across concurrent script awaits", async ({ page }) => {
  const source = `
    import { capture } from "library"
    import { onFrame, scene } from "@drawcall/glts"
    scene.userData.urls = [capture()]
    await Promise.resolve()
    scene.userData.urls.push(capture())
    onFrame(() => scene.userData.urls.push(capture()))
  `;
  await routeScript(page, "**/assets/scope-*.glts", source);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      modules: { library: { capture: () => window.getGLTSContext().url } },
    });
    const scenes = await Promise.all([
      loader.loadAsync("/assets/scope-a.glts"),
      loader.loadAsync("/assets/scope-b.glts"),
    ]);
    for (const scene of scenes) scene.update(0.1);
    let outside = "";
    try { window.getGLTSContext(); } catch (error) {
      if (!(error instanceof Error)) throw error;
      outside = error.message;
    }
    const urls = scenes.map((scene) => scene.userData.urls);
    loader.dispose();
    return { urls, outside };
  });
  expect(result.urls).toEqual([
    Array(3).fill(new URL("/assets/scope-a.glts", page.url()).href),
    Array(3).fill(new URL("/assets/scope-b.glts", page.url()).href),
  ]);
  expect(result.outside).toBe("No GLTS execution is active");
});
