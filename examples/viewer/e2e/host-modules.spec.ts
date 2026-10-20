import { expect, test } from "@playwright/test";
import { routeScript } from "./routes.js";

test("gives scripts the host's own instance of a shared module", async ({ page }) => {
  await routeScript(page, "**/shared.glts", `
    import { scene } from "@drawcall/glts";
    import { Marker } from "host-library";
    scene.userData.marker = new Marker();
  `);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    class Marker {}
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      modules: { "host-library": { Marker } },
    });
    try {
      const scene = await loader.loadAsync("/shared.glts");
      return scene.userData.marker instanceof Marker;
    } finally {
      loader.dispose();
    }
  });
  expect(result).toBe(true);
});
