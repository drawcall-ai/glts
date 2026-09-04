import { expect, test } from "@playwright/test";

import { routeGLTS, routeGLTSRevisions } from "./routes.js";

test("executes native instancing once and preserves matrices across reload", async ({ page }) => {
  const source = (revision: string) => `
    import * as THREE from "three"
    import {
      instanceCount, onDispose, onFrame, onMatrixUpdateAt, scene,
    } from "@drawcall/glts"

    globalThis.__instanceExecutions = (globalThis.__instanceExecutions ?? 0) + 1
    scene.name = ${JSON.stringify(revision)}
    scene.userData.authoredRevision = ${JSON.stringify(revision)}
    scene.userData.instanceCount = instanceCount
    const geometry = new THREE.BoxGeometry()
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.InstancedMesh(geometry, material, instanceCount)
    scene.add(mesh)
    onMatrixUpdateAt((index, matrix) => {
      globalThis.__matrixUpdates = (globalThis.__matrixUpdates ?? 0) + 1
      mesh.setMatrixAt(index, matrix)
      mesh.instanceMatrix.needsUpdate = true
    })
    onFrame(() => { scene.userData.frameRevision = ${JSON.stringify(revision)} })
    onDispose(() => {
      geometry.dispose()
      material.dispose()
      globalThis.__instanceDisposals = (globalThis.__instanceDisposals ?? 0) + 1
    })
  `;
  await routeGLTSRevisions(page, "**/assets/native.glts", [
    source("first"),
    source("second")
  ]);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const instances = await loader.loadInstancesAsync("/assets/native.glts", 3);
    const stable = instances;
    instances.position.x = 9;
    const matrix = new DOMMatrix().translate(4, 5, 6);
    const threeMatrix = new (Reflect.get(window, "Matrix4"))().fromArray(matrix.toFloat64Array());
    const setResult = instances.setMatrixAt(1, threeMatrix);
    await instances.reload();
    instances.update(0.1);
    const resultMatrix = new (Reflect.get(window, "Matrix4"))();
    const getResult = instances.getMatrixAt(1, resultMatrix);
    const snapshot = {
      count: instances.count,
      executions: Reflect.get(globalThis, "__instanceExecutions"),
      frameRevision: instances.userData.frameRevision,
      instanceCount: instances.userData.instanceCount,
      matrix: resultMatrix.elements.slice(12, 15),
      returnsMatrix: getResult === resultMatrix,
      returnsSelf: setResult === instances,
      matrixUpdates: Reflect.get(globalThis, "__matrixUpdates"),
      name: instances.name,
      position: instances.position.x,
      rootRevision: instances.userData.authoredRevision,
      stable: stable === instances
    };
    instances.dispose();
    const disposals = Reflect.get(globalThis, "__instanceDisposals");
    loader.dispose();
    return { ...snapshot, disposals };
  });

  expect(result).toEqual({
    count: 3,
    disposals: 2,
    executions: 2,
    frameRevision: "second",
    instanceCount: 3,
    matrix: [4, 5, 6],
    matrixUpdates: 7,
    name: "second",
    position: 9,
    returnsMatrix: true,
    returnsSelf: true,
    rootRevision: "second",
    stable: true
  });
});

test("automatically instances an ordinary mesh hierarchy", async ({ page }) => {
  await routeGLTS(page, "**/assets/automatic.glts", `
    import * as THREE from "three"
    import { scene } from "@drawcall/glts"
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
    )
    mesh.position.x = 2
    scene.add(mesh)
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const instances = await loader.loadInstancesAsync("/assets/automatic.glts", 2);
    const translation = new (Reflect.get(window, "Matrix4"))().makeTranslation(5, 0, 0);
    instances.setMatrixAt(1, translation);
    const mesh = instances.children.find((child) => Reflect.get(child, "isInstancedMesh"));
    if (!(mesh instanceof window.InstancedMesh)) {
      throw new Error("Automatic InstancedMesh was not created");
    }
    const matrix = new (Reflect.get(window, "Matrix4"))();
    Reflect.apply(Reflect.get(mesh, "getMatrixAt"), mesh, [1, matrix]);
    mesh.boundingSphere = new window.Sphere();
    instances.setMatrixAt(0, translation);
    let targetDisposals = 0;
    mesh.addEventListener("dispose", () => { targetDisposals += 1; });
    const snapshot = {
      boundsInvalidated: mesh.boundingSphere === null,
      count: instances.count,
      sourceHidden: instances.children.some((child) => child.visible === false),
      translation: matrix.elements.slice(12, 15)
    };
    instances.dispose();
    loader.dispose();
    return { ...snapshot, targetDisposals };
  });

  expect(result).toEqual({
    boundsInvalidated: true,
    count: 2,
    sourceHidden: true,
    targetDisposals: 1,
    translation: [7, 0, 0]
  });
});

test("attempts every automatic target disposal after one fails", async ({ page }) => {
  await routeGLTS(page, "**/assets/disposal.glts", `
    import * as THREE from "three"
    import { scene } from "@drawcall/glts"
    scene.add(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()),
      new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial()),
    )
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const instances = await loader.loadInstancesAsync("/assets/disposal.glts", 2);
    const targets = instances.children.filter(
      (child): child is InstanceType<typeof window.InstancedMesh> =>
        child instanceof window.InstancedMesh
    );
    if (targets.length !== 2) {
      throw new Error(`Expected two automatic targets, received ${targets.length}`);
    }

    let laterDisposals = 0;
    targets[0]?.addEventListener("dispose", () => {
      throw new Error("first disposal failed");
    });
    targets[1]?.addEventListener("dispose", () => {
      laterDisposals += 1;
    });

    let rejected = false;
    try {
      instances.dispose();
    } catch {
      rejected = true;
    }
    loader.dispose();
    return { laterDisposals, rejected };
  });

  expect(result).toEqual({ laterDisposals: 1, rejected: true });
});

test("rejects automatic instancing of composed GLTS scenes", async ({ page }) => {
  await routeGLTS(page, "**/assets/composed-child.glts", `
    import * as THREE from "three"
    import { onDispose, scene } from "@drawcall/glts"
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    onDispose(() => { globalThis.__composedChildDisposals = 1 })
  `);
  await routeGLTS(page, "**/assets/composed-parent.glts", `
    import { gltsLoader, scene } from "@drawcall/glts"
    scene.add(await gltsLoader.loadAsync(new URL("./composed-child.glts", import.meta.url)))
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    let message = "";
    try {
      await loader.loadInstancesAsync("/assets/composed-parent.glts", 2);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const disposals = Reflect.get(globalThis, "__composedChildDisposals");
    loader.dispose();
    return { disposals, message };
  });

  expect(result.disposals).toBe(1);
  expect(result.message).toContain("cannot contain nested GLTS scenes");
});
