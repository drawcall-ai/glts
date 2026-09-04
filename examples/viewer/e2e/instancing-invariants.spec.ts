import { expect, test } from "@playwright/test";

import { routeGLTS } from "./routes.js";

test("protects stored matrices from native callbacks", async ({ page }) => {
  await routeGLTS(page, "**/assets/mutating-native.glts", `
    import { onMatrixUpdateAt } from "@drawcall/glts"
    onMatrixUpdateAt((_index, matrix) => {
      matrix.elements[12] += 100
    })
  `);

  await page.goto("/test-harness.html");
  const translation = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadInstancesAsync("/assets/mutating-native.glts", 2);
    const Matrix4 = Reflect.get(window, "Matrix4");
    node.setMatrixAt(1, new Matrix4().makeTranslation(7, 0, 0));
    const stored = new Matrix4();
    node.getMatrixAt(1, stored);
    node.dispose();
    loader.dispose();
    return stored.elements[12];
  });

  expect(translation).toBe(7);
});

test("preserves ancestor visibility during automatic instancing", async ({ page }) => {
  await routeGLTS(page, "**/assets/hidden-automatic.glts", `
    import * as THREE from "three"
    import { scene } from "@drawcall/glts"
    const hidden = new THREE.Group()
    hidden.visible = false
    hidden.add(new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
    ))
    scene.add(hidden)
  `);

  await page.goto("/test-harness.html");
  const visible = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadInstancesAsync("/assets/hidden-automatic.glts", 2);
    const mesh = node.children.find((child) => child instanceof window.InstancedMesh);
    if (!mesh) throw new Error("Automatic InstancedMesh was not created");
    const result = mesh.visible;
    node.dispose();
    loader.dispose();
    return result;
  });

  expect(visible).toBe(false);
});

test("reports managed-node augmentation as construction", async ({ page }) => {
  await routeGLTS(page, "**/assets/frozen-phase.glts", `
    import { scene } from "@drawcall/glts"
    Object.preventExtensions(scene)
  `);

  await page.goto("/test-harness.html");
  const phase = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      await loader.loadAsync("/assets/frozen-phase.glts");
      return "resolved";
    } catch (error) {
      return window.readErrorField(error, "phase");
    } finally {
      loader.dispose();
    }
  });

  expect(phase).toBe("construct");
});
