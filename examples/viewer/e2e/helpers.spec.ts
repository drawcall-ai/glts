import { expect, test } from "@playwright/test";

import { fulfillScript } from "./routes.js";

test("runs helpers, shares them within a script, and reloads their scripts when they change", async ({ page }) => {
  const sources: Record<string, string> = {
    "/assets/scene.glts": `
      import * as THREE from "three"
      import { onDispose, scene } from "@drawcall/glts"
      import { box, registry, Size } from "./parts/box.ts"
      import { registry as same } from "./registry.ts"
      const size: Size = 2
      const mesh = box(size)
      scene.add(mesh)
      scene.userData.shared = registry === same
      scene.userData.three = mesh instanceof THREE.Mesh
      onDispose(() => mesh.geometry.dispose())
    `,
    "/assets/other.glts": `
      import { scene } from "@drawcall/glts"
      import { label } from "./parts/box.ts"
      scene.name = label
    `,
    "/assets/parts/box.ts": `
      import * as THREE from "three"
      export { registry } from "../registry.ts"
      export type Size = number
      export const label: string = "box v" + globalThis.__boxVersion
      export function box(size: number): THREE.Mesh {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size))
        mesh.name = label
        return mesh
      }
    `,
    "/assets/registry.ts": `export const registry = new Map<string, number>()`,
  };
  await page.route(/\/assets\/.*\.(glts|ts)$/, (route) => {
    const source = sources[new URL(route.request().url()).pathname];
    return source === undefined ? route.fulfill({ status: 404 }) : fulfillScript(route, source);
  });

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    Reflect.set(globalThis, "__boxVersion", 1);
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      const scene = await loader.loadAsync("/assets/scene.glts");
      const other = await loader.loadAsync("/assets/other.glts");
      const before = [scene.children[0]?.name, other.name];
      Reflect.set(globalThis, "__boxVersion", 2);
      await loader.reload("/assets/parts/box.ts");
      return {
        before,
        after: [scene.children[0]?.name, other.name],
        shared: scene.userData.shared,
        three: scene.userData.three,
      };
    } finally {
      loader.dispose();
    }
  });
  expect(result).toEqual({
    before: ["box v1", "box v1"],
    after: ["box v2", "box v2"],
    shared: true,
    three: true,
  });
});

test("compiles TypeGPU 'use gpu' functions of scripts and helpers in the browser", async ({ page }) => {
  const sources: Record<string, string> = {
    "/assets/gpu.glts": `
      import { scene } from "@drawcall/glts"
      import { triple } from "./triple.ts"
      const double = (x: number): number => { "use gpu"; return x * 2 }
      const meta: WeakMap<object, unknown> | undefined = Reflect.get(globalThis, "__TYPEGPU_META__")
      scene.userData.compiled = [meta?.has(double), meta?.has(triple)]
    `,
    "/assets/triple.ts": `export function triple(x: number): number { "use gpu"; return x * 3 }`,
  };
  await page.route(/\/assets\/.*\.(glts|ts)$/, (route) => {
    const source = sources[new URL(route.request().url()).pathname];
    return source === undefined ? route.fulfill({ status: 404 }) : fulfillScript(route, source);
  });

  await page.goto("/test-harness.html");
  const compiled = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      return (await loader.loadAsync("/assets/gpu.glts")).userData.compiled;
    } finally {
      loader.dispose();
    }
  });
  expect(compiled).toEqual([true, true]);
});
