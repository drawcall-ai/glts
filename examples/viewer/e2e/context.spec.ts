import { expect, test } from "@playwright/test";

import { routeGLTS } from "./routes.js";

test("returns the authored scene and runs contextual lifecycle hooks", async ({ page }) => {
  await routeGLTS(page, "**/assets/context.glts", `
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
      cloneManaged: Reflect.has(clone, "reload"),
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

test("enables preview only for the root across recursion and reload", async ({ page }) => {
  await routeGLTS(page, "**/assets/parent.glts", `
    import { gltsLoader, isPreview, scene } from "@drawcall/glts"
    globalThis.__parentContextLoader = gltsLoader
    scene.userData.preview = isPreview
    const child = await gltsLoader.loadAsync(new URL("./child.glts", import.meta.url))
    scene.add(child)
  `);
  await routeGLTS(page, "**/assets/child.glts", `
    import { gltsLoader, isPreview, onDispose, scene } from "@drawcall/glts"
    scene.name = "child"
    scene.userData.preview = isPreview
    scene.userData.scopedLoader = gltsLoader !== globalThis.__parentContextLoader
    const grandchild = await gltsLoader.loadAsync(new URL("./grandchild.glts", import.meta.url))
    scene.add(grandchild)
    onDispose(() => { globalThis.__childDisposed = true })
  `);
  await routeGLTS(page, "**/assets/grandchild.glts", `
    import { isPreview, scene } from "@drawcall/glts"
    scene.name = "grandchild"
    scene.userData.preview = isPreview
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    const loader = new window.GLTSLoader(manager, { isPreview: true });
    const parent = await loader.loadAsync("/assets/parent.glts");
    const child = parent.children[0];
    if (!child) throw new Error("Child was not loaded");
    const grandchild = child.children[0];
    if (!grandchild) throw new Error("Grandchild was not loaded");
    const contextLoader = Reflect.get(globalThis, "__parentContextLoader");
    const initial = {
      childName: child.name,
      childPreview: child.userData.preview,
      grandchildPreview: grandchild.userData.preview,
      managerForwarded: Reflect.get(contextLoader, "manager") === manager,
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
    loader.dispose();
    return { ...initial, childDisposed, reloaded };
  });

  expect(result).toEqual({
    childDisposed: true,
    childName: "child",
    childPreview: false,
    grandchildPreview: false,
    managerForwarded: true,
    parentPreview: true,
    reloaded: {
      childPreview: false,
      grandchildPreview: false
    },
    scopedLoader: true
  });
});
