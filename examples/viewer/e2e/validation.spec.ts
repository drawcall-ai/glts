import { expect, test } from "@playwright/test";

import { routeGLTS } from "./routes.js";

test("rejects exports and invalid imports at their owning boundaries", async ({ page }) => {
  await routeGLTS(page, "**/assets/export.glts", "export const value = 1");
  await routeGLTS(
    page,
    "**/assets/class-import.glts",
    'import { GLTSLoader } from "@drawcall/glts"'
  );
  await routeGLTS(
    page,
    "**/assets/static-import.glts",
    'import Child from "./child.glts"'
  );

  await routeGLTS(page, "**/assets/missing-import.glts", 'import { missing } from "@drawcall/glts"');
  await routeGLTS(page, "**/assets/default-import.glts", 'import glts from "@drawcall/glts"');

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
  expect(errors[1]).toMatchObject({ phase: "evaluate", cause: expect.stringContaining("GLTSLoader") });
  expect(errors[2]).toMatchObject({ phase: "resolve", message: expect.stringContaining("use gltsLoader.loadAsync()") });
  expect(errors[3]).toMatchObject({ phase: "evaluate", cause: expect.stringContaining("missing") });
  expect(errors[4]).toMatchObject({ phase: "evaluate", cause: expect.stringContaining("default") });
});

test("accepts namespace and aliased imports from the context module", async ({ page }) => {
  await routeGLTS(page, "**/assets/namespace-import.glts", `
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

test("rejects contextual graph reloads", async ({ page }) => {
  await routeGLTS(page, "**/assets/contextual-reload.glts", `
    import { gltsLoader } from "@drawcall/glts"
    await gltsLoader.reload(new URL("./other.glts", import.meta.url))
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      await loader.loadAsync("/assets/contextual-reload.glts");
      return { message: "resolved", phase: "resolved" };
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        phase: window.readErrorField(error, "phase")
      };
    } finally {
      loader.dispose();
    }
  });

  expect(result.phase).toBe("reload");
  expect(result.message).toContain("cannot reload the live graph");
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
