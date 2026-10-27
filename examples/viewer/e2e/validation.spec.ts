import { expect, test } from "@playwright/test";

import { routeScript } from "./routes.js";

test("rejects exports and invalid imports at their owning boundaries", async ({ page }) => {
  await routeScript(page, "**/assets/export.glts", "export const value = 1");
  await routeScript(
    page,
    "**/assets/class-import.glts",
    'import { GLTSLoader } from "@drawcall/glts"; console.log(GLTSLoader)'
  );
  await routeScript(
    page,
    "**/assets/static-import.glts",
    'import Child from "./child.glts"; console.log(Child)'
  );

  await routeScript(page, "**/assets/missing-import.glts", 'import { missing } from "@drawcall/glts"; console.log(missing)');
  await routeScript(page, "**/assets/default-import.glts", 'import glts from "@drawcall/glts"; console.log(glts)');

  await page.goto("/test-harness.html");
  const errors = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const errors = [];
    for (const url of [
      "/assets/export.glts",
      "/assets/class-import.glts",
      "/assets/static-import.glts",
      "/assets/missing-import.glts",
      "/assets/default-import.glts"
    ]) {
      try {
        await loader.loadAsync(url);
      } catch (error) {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : "",
          phase: window.readErrorField(error, "phase")
        });
      }
    }
    loader.dispose();
    return errors;
  });

  expect(errors).toHaveLength(5);
  expect(errors[0]).toMatchObject({ phase: "transform", message: expect.stringContaining("must not export values") });
  expect(errors[1]).toMatchObject({ phase: "transform", cause: expect.stringContaining("GLTSLoader") });
  expect(errors[2]).toMatchObject({ phase: "resolve", message: expect.stringContaining("use gltsLoader.loadAsync()") });
  expect(errors[3]).toMatchObject({ phase: "transform", cause: expect.stringContaining("missing") });
  expect(errors[4]).toMatchObject({ phase: "transform", cause: expect.stringContaining("default") });
});

test("accepts namespace and aliased script imports", async ({ page }) => {
  await routeScript(page, "**/assets/namespace-import.glts", `
    import * as glts from "@drawcall/glts"
    import { scene as currentScene } from "@drawcall/glts"
    if (glts.scene !== currentScene) throw new Error("Context scene mismatch")
    glts.scene.name = "namespace scene"
    glts.onFrame((delta) => { currentScene.userData.elapsed = delta })
  `);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const node = await loader.loadAsync("/assets/namespace-import.glts");
    node.update(0.25);
    const result = { name: node.name, elapsed: node.userData.elapsed };
    loader.dispose();
    return result;
  });
  expect(result).toEqual({ name: "namespace scene", elapsed: 0.25 });
});

test("reports node augmentation as construction", async ({ page }) => {
  await routeScript(page, "**/assets/frozen-phase.glts", `
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
