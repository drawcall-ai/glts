import { expect, test } from "@playwright/test";

import { routeGLTS } from "./routes.js";

test("returns the authored group and runs contextual lifecycle hooks", async ({ page }) => {
  await routeGLTS(page, "**/assets/context.glts", `
    import * as THREE from "three"
    import { isPreview, onDispose, onFrame, scene } from "@drawcall/glts"

    scene.name = "context scene"
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    if (isPreview) {
      scene.add(new THREE.PerspectiveCamera(), new THREE.AmbientLight())
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
    let cameras = 0;
    let lights = 0;
    node.traverse((object) => {
      if (Reflect.get(object, "isCamera") === true) cameras += 1;
      if (Reflect.get(object, "isLight") === true) lights += 1;
    });
    const snapshot = {
      cameras,
      cloneManaged: Reflect.has(clone, "reload"),
      elapsed: node.userData.elapsed,
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
    cameras: 1,
    cloneManaged: false,
    disposals: 1,
    elapsed: 0.25,
    lights: 1,
    name: "context scene",
    url: "http://127.0.0.1:5173/assets/context.glts"
  });
});

test("shares one runtime while keeping recursive loaders scoped", async ({ page }) => {
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
    onDispose(() => { globalThis.__childDisposed = true })
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const manager = new window.LoadingManager();
    const loader = new window.GLTSLoader(manager, { isPreview: true });
    const parent = await loader.loadAsync("/assets/parent.glts");
    const child = parent.children[0];
    if (!child) throw new Error("Child was not loaded");
    const contextLoader = Reflect.get(globalThis, "__parentContextLoader");
    const snapshot = {
      childName: child.name,
      childPreview: child.userData.preview,
      managerForwarded: Reflect.get(contextLoader, "manager") === manager,
      parentPreview: parent.userData.preview,
      scopedLoader: child.userData.scopedLoader
    };
    parent.dispose();
    const childDisposed = Reflect.get(globalThis, "__childDisposed");
    loader.dispose();
    return { ...snapshot, childDisposed };
  });

  expect(result).toEqual({
    childDisposed: true,
    childName: "child",
    childPreview: false,
    managerForwarded: true,
    parentPreview: true,
    scopedLoader: true
  });
});
