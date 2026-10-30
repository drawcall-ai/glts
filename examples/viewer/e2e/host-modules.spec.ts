import { expect, test } from "@playwright/test";
import { routeScript } from "./routes.js";

test("shares host package and helper namespaces with source provenance", async ({ page }) => {
  await routeScript(page, "**/shared.glts", `
    import { scene } from "@drawcall/glts";
    import { Marker } from "host-library";
    import { resource } from "./shared.ts";
    scene.userData.resource = resource;
    scene.userData.marker = new Marker();
  `);
  await routeScript(page, "**/shared.ts", `
    import "three/webgpu";
    throw new Error("Host-provided helpers must not initialize");
    export const resource = undefined;
  `);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    class Marker {}
    const resource = {};
    const helperURL = new URL("/shared.ts", location.href).href;
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      modules: { "host-library": { Marker }, [helperURL]: { resource } },
    });
    try {
      const scene = await loader.loadAsync("/shared.glts");
      return {
        marker: scene.userData.marker instanceof Marker,
        resource: scene.userData.resource === resource,
        files: scene.source.dependencyUrls.map((url) => new URL(url).pathname),
        packages: scene.source.packages,
      };
    } finally {
      loader.dispose();
    }
  });
  expect(result).toEqual({ marker: true, resource: true, files: ["/shared.ts"], packages: ["@drawcall/glts", "host-library", "three"] });
});
