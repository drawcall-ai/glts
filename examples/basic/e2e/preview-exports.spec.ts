import { expect, test } from "@playwright/test";

function previewSource(
  camera: "PerspectiveCamera" | "OrthographicCamera",
  light: "AmbientLight" | "PointLight",
  name: string
): string {
  return `
    import * as THREE from "three"

    export const previewCamera = new THREE.${camera}()
    const lighting = new THREE.Group()
    lighting.add(new THREE.${light}())
    export { lighting as previewLighting }

    export default class Asset extends THREE.Group {
      constructor() {
        super()
        this.name = ${JSON.stringify(name)}
      }
    }
  `;
}

test("exposes root preview exports separately and updates them on reload", async ({ page }) => {
  const sources = [
    previewSource("PerspectiveCamera", "AmbientLight", "first"),
    previewSource("OrthographicCamera", "PointLight", "second")
  ];
  let requests = 0;
  await page.route("**/assets/preview-root.glts", (route) => {
    const source = sources[requests];
    requests += 1;
    if (!source) {
      throw new Error("Preview root was fetched more than twice");
    }
    return route.fulfill({ body: source, contentType: "text/plain" });
  });

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/preview-root.glts");
    const root = asset.scene;
    const firstCamera = asset.previewCamera;
    const firstLighting = asset.previewLighting;
    const before = {
      camera: firstCamera?.type,
      lighting: firstLighting?.children.map((child) => child.type),
      scene: asset.scene.children.map((child) => child.name),
      separateCamera: !asset.scene.getObjectByProperty("uuid", firstCamera?.uuid),
      separateLighting: !asset.scene.getObjectByProperty("uuid", firstLighting?.uuid)
    };

    await asset.reload();
    const after = {
      camera: asset.previewCamera?.type,
      lighting: asset.previewLighting?.children.map((child) => child.type),
      replacedCamera: asset.previewCamera !== firstCamera,
      replacedLighting: asset.previewLighting !== firstLighting,
      scene: asset.scene.children.map((child) => child.name),
      stableScene: asset.scene === root
    };
    asset.dispose();
    loader.dispose();
    return { after, before };
  });

  expect(requests).toBe(2);
  expect(result).toEqual({
    after: {
      camera: "OrthographicCamera",
      lighting: ["PointLight"],
      replacedCamera: true,
      replacedLighting: true,
      scene: ["second"],
      stableScene: true
    },
    before: {
      camera: "PerspectiveCamera",
      lighting: ["AmbientLight"],
      scene: ["first"],
      separateCamera: true,
      separateLighting: true
    }
  });
});

test("supports absent preview exports", async ({ page }) => {
  await page.route("**/assets/no-preview.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      export default class Asset extends THREE.Group {}
    `,
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const asset = await loader.loadAsync("/assets/no-preview.glts");
    const absent = {
      camera: asset.previewCamera === undefined,
      lighting: asset.previewLighting === undefined
    };
    asset.dispose();
    loader.dispose();
    return absent;
  });

  expect(result).toEqual({ camera: true, lighting: true });
});

test("reports type-specific diagnostics for invalid preview exports", async ({ page }) => {
  await page.route("**/assets/invalid-preview-camera.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      export const previewCamera = new THREE.Group()
      export default class Asset extends THREE.Group {}
    `,
    contentType: "text/plain"
  }));
  await page.route("**/assets/invalid-preview-lighting.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      export const previewLighting = new THREE.Group()
      export default class Asset extends THREE.Group {}
    `,
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const diagnostics = await page.evaluate(async () => {
    const urls = [
      "/assets/invalid-preview-camera.glts",
      "/assets/invalid-preview-lighting.glts"
    ];
    const loader = new window.GLTSLoader();
    const values: { message: string; phase: unknown; url: unknown }[] = [];
    for (const url of urls) {
      try {
        await loader.loadAsync(url);
        throw new Error(`Expected ${url} to fail`);
      } catch (error) {
        values.push({
          message: error instanceof Error ? error.message : String(error),
          phase: typeof error === "object" && error !== null
            ? Reflect.get(error, "phase")
            : undefined,
          url: typeof error === "object" && error !== null
            ? Reflect.get(error, "url")
            : undefined
        });
      }
    }
    loader.dispose();
    return values;
  });

  expect(diagnostics).toEqual([
    {
      message: [
        '[GLTS:evaluate] Named export "previewCamera" must be a THREE.Camera; received THREE.Group',
        "URL: http://127.0.0.1:5173/assets/invalid-preview-camera.glts"
      ].join("\n"),
      phase: "evaluate",
      url: "http://127.0.0.1:5173/assets/invalid-preview-camera.glts"
    },
    {
      message: [
        '[GLTS:evaluate] Named export "previewLighting" must contain at least one THREE.Light; received THREE.Group with no lights',
        "URL: http://127.0.0.1:5173/assets/invalid-preview-lighting.glts"
      ].join("\n"),
      phase: "evaluate",
      url: "http://127.0.0.1:5173/assets/invalid-preview-lighting.glts"
    }
  ]);
});

test("keeps imported preview metadata out of parent assets", async ({ page }) => {
  await page.route("**/assets/preview-parent.glts", (route) => route.fulfill({
    body: `
      import * as THREE from "three"
      import Child from "./preview-child.glts"

      export default class Parent extends THREE.Group {
        constructor() {
          super()
          this.add(new Child())
        }
      }
    `,
    contentType: "text/plain"
  }));
  await page.route("**/assets/preview-child.glts", (route) => route.fulfill({
    body: previewSource("PerspectiveCamera", "AmbientLight", "child"),
    contentType: "text/plain"
  }));

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader();
    const parent = await loader.loadAsync("/assets/preview-parent.glts");
    const parentTypes: string[] = [];
    parent.scene.traverse((object) => parentTypes.push(object.type));

    const child = await loader.loadAsync("/assets/preview-child.glts");
    const snapshot = {
      childCamera: child.previewCamera?.type,
      childLighting: child.previewLighting?.children.map((object) => object.type),
      parentCamera: parent.previewCamera === undefined,
      parentHasPreviewObjects: parentTypes.some((type) => type.endsWith("Camera") || type.endsWith("Light")),
      parentLighting: parent.previewLighting === undefined
    };
    parent.dispose();
    child.dispose();
    loader.dispose();
    return snapshot;
  });

  expect(result).toEqual({
    childCamera: "PerspectiveCamera",
    childLighting: ["AmbientLight"],
    parentCamera: true,
    parentHasPreviewObjects: false,
    parentLighting: true
  });
});
