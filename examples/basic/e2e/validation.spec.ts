import { expect, test } from "@playwright/test";

import { routeGLTS } from "./routes.js";

test("rejects exports, GLTSLoader imports, and static GLTS imports", async ({ page }) => {
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

  await page.goto("/test-harness.html");
  const messages = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const messages: string[] = [];
    for (const url of [
      "/assets/export.glts",
      "/assets/class-import.glts",
      "/assets/static-import.glts"
    ]) {
      try {
        await loader.loadAsync(url);
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    loader.dispose();
    return messages;
  });

  expect(messages[0]).toContain("must not export values");
  expect(messages[1]).toContain("import gltsLoader instead");
  expect(messages[2]).toContain("use gltsLoader.loadAsync()");
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
