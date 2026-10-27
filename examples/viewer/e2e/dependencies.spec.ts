import { expect, test } from "@playwright/test";

import { deferred } from "./deferred.js";
import { routeScript } from "./routes.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");

test("each execution records shared in-flight files and subsequent cache hits", async ({ page }) => {
  await routeScript(page, "**/assets/shared-*.glts", `
    import { Cache, FileLoader } from "three"
    import { loadingManager } from "@drawcall/glts"
    import { started } from "checkpoint"
    import "./dependency-helper.ts"
    Cache.enabled = true
    const pending = new FileLoader(loadingManager).loadAsync(new URL("./shared.bin", import.meta.url).href)
    started()
    await pending
  `);
  await routeScript(page, "**/assets/dependency-helper.ts", "export const value = 1;");
  const release = deferred();
  let requests = 0;
  await page.route("**/assets/shared.bin", async (route) => {
    requests += 1;
    await release.promise;
    await route.fulfill({ body: "shared" });
  });
  await page.goto("/test-harness.html");
  const loading = page.evaluate(async () => {
    let started = 0;
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      modules: { checkpoint: { started: () => Reflect.set(window, "__started", ++started) } },
    });
    try {
      const scenes = await Promise.all([
        loader.loadAsync("/assets/shared-a.glts"),
        loader.loadAsync("/assets/shared-b.glts"),
      ]);
      scenes.push(await loader.loadAsync("/assets/shared-c.glts"));
      return scenes.map((scene) => scene.source.dependencyUrls);
    } finally {
      loader.dispose();
    }
  });
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__started"))).toBe(2);
  release.resolve();
  expect(await loading).toEqual(Array.from({ length: 3 }, () =>
    ["dependency-helper.ts", "shared.bin"].map((file) => new URL(`/assets/${file}`, page.url()).href)
  ));
  expect(requests).toBe(1);
});

test("tracks image elements, cube faces, and image cache reuse", async ({ page }) => {
  await routeScript(page, "**/assets/images.glts", `
    import { Cache, CubeTextureLoader, TextureLoader } from "three"
    import { loadingManager, onDispose } from "@drawcall/glts"
    Cache.enabled = true
    const url = new URL("./pixel.png", import.meta.url).href
    const texture = await new TextureLoader(loadingManager).loadAsync(url)
    const cube = await new CubeTextureLoader(loadingManager).loadAsync([url, ...Array(5).fill(new URL("./face.png", import.meta.url).href)])
    onDispose(() => { texture.dispose(); cube.dispose() })
  `);
  await page.route(/\/assets\/(pixel|face)\.png$/, (route) => route.fulfill({ body: png, contentType: "image/png" }));
  await page.goto("/test-harness.html");
  const dependencyUrls = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      return (await loader.loadAsync("/assets/images.glts")).source.dependencyUrls;
    } finally {
      loader.dispose();
    }
  });
  expect(dependencyUrls).toEqual(["face.png", "pixel.png"].map((file) => new URL(`/assets/${file}`, page.url()).href));
});

for (const brokenImage of [false, true]) {
  test(`composite GLTF ${brokenImage ? "rejects a swallowed texture failure" : "records its external buffer and image"}`, async ({ page }) => {
    await routeScript(page, "**/assets/model.glts", `
      import { GLTFLoader } from "loaders"
      import { loadingManager, scene } from "@drawcall/glts"
      const model = await new GLTFLoader(loadingManager).loadAsync(new URL("./model.gltf", import.meta.url).href)
      scene.add(model.scene)
    `);
    await page.route("**/assets/model.gltf", (route) => route.fulfill({ json: {
      asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      buffers: [{ uri: "triangle.bin", byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }], images: [{ uri: "pixel.png" }],
    } }));
    await page.route("**/assets/triangle.bin", (route) => route.fulfill({ body: Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer) }));
    await page.route("**/assets/pixel.png", (route) => route.fulfill({ body: brokenImage ? "missing" : png, status: brokenImage ? 404 : 200, contentType: "image/png" }));
    await page.goto("/test-harness.html");
    const result = await page.evaluate(async () => {
      const loader = new window.GLTSLoader(new window.LoadingManager(), {
        modules: { loaders: { GLTFLoader: window.GLTFLoader } },
      });
      try {
        return { dependencyUrls: (await loader.loadAsync("/assets/model.glts")).source.dependencyUrls };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { error: error.message };
      } finally {
        loader.dispose();
      }
    });
    if (brokenImage) {
      expect(result.error).toContain("Resources failed to load");
      expect(result.error).toContain("pixel.png");
      return;
    }
    expect(result).toEqual({ dependencyUrls: ["model.gltf", "pixel.png", "triangle.bin"].map((file) => new URL(`/assets/${file}`, page.url()).href) });
  });
}
