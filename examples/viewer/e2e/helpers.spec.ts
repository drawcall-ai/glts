import { expect, test } from "@playwright/test";

test("runs helpers, shares them within a script, and reloads their scripts when they change", async ({ page }) => {
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    let version = 1;
    const sources: Record<string, () => string> = {
      "/assets/scene.glts": () => `
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
      "/assets/other.glts": () => `
        import { scene } from "@drawcall/glts"
        import { label } from "./parts/box.ts"
        scene.name = label
      `,
      "/assets/parts/box.ts": () => `
        import * as THREE from "three"
        export { registry } from "../registry.ts"
        export type Size = number
        export const label: string = "box v${version}"
        export function box(size: number): THREE.Mesh {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size))
          mesh.name = label
          return mesh
        }
      `,
      "/assets/registry.ts": () => `export const registry = new Map<string, number>()`,
    };
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      fetch: async (input) => {
        const source = sources[new URL(String(input)).pathname];
        return source ? new Response(source()) : new Response(null, { status: 404 });
      },
    });
    try {
      const scene = await loader.loadAsync("/assets/scene.glts");
      const other = await loader.loadAsync("/assets/other.glts");
      const before = [scene.children[0]?.name, other.name];
      version = 2;
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
