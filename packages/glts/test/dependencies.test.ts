import { expect, it } from "vitest";

import { getGLTSSource } from "../src/execution/current.js";
import type { GLTSSource } from "../src/types.js";
import { base, deferred, serve } from "./loader/fixture.js";

const requestResource = `import { loadingManager } from "@drawcall/glts";
  const resource = loadingManager.resolveURL(new URL("./bark.png", import.meta.url).href);
  loadingManager.itemStart(resource); loadingManager.itemEnd(resource);`;

it("reports transitive helper, nested GLTS, and resource files as frozen snapshots", async () => {
  let captured: GLTSSource | undefined;
  const snapshots: (readonly string[])[] = [];
  const loader = serve({
    "scene.glts": `import "./helper.ts";
      import { scene, gltsLoader } from "@drawcall/glts";
      import { capture } from "library"; capture();
      scene.add(await gltsLoader.loadAsync("./child.glts"));
      ${requestResource}
      loadingManager.itemStart(resource); loadingManager.itemEnd(resource);
      loadingManager.itemStart("data:text/plain,inline"); loadingManager.itemEnd("data:text/plain,inline");`,
    "helper.ts": `import "./shared.ts"; import "three";`,
    "shared.ts": `export const value = 1;`,
    "child.glts": `import "./child-helper.ts"; ${requestResource}`,
    "child-helper.ts": `export const value = 2;`,
  }, { capture: () => {
    captured = getGLTSSource();
    snapshots.push(captured.dependencyUrls);
  } });
  loader.manager.setURLModifier((url) => url.endsWith("bark.png") ? `${base}textures/bark.png?v=2#part` : url);
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(snapshots[0]).toEqual([`${base}helper.ts`, `${base}shared.ts`]);
  expect(scene.source.dependencyUrls).toEqual([
    "bark.png", "child-helper.ts", "child.glts", "helper.ts", "shared.ts", "textures/bark.png?v=2",
  ].map((path) => base + path));
  expect(scene.source).toBe(captured);
  expect(Object.isFrozen(scene.source.dependencyUrls)).toBe(true);
  expect(Object.isFrozen(snapshots[0])).toBe(true);
});

it("keeps later dynamic file imports separate between executions sharing cached source", async () => {
  const finished = deferred();
  let completed = 0;
  let next = 0;
  const loader = serve({
    "scene.glts": `import { onFrame } from "@drawcall/glts";
      import { choice, finish } from "library";
      onFrame(async () => { await import(choice()); finish(); });`,
    "a.ts": `import "./common.ts";`,
    "b.ts": `import "./common.ts";`,
    "common.ts": `export const value = 1;`,
  }, {
    choice: () => next++ === 0 ? "./a.ts" : "./b.ts",
    finish: () => { if (++completed === 2) finished.resolve(); },
  });
  const scenes = await Promise.all([loader.loadAsync(`${base}scene.glts`), loader.loadAsync(`${base}scene.glts`)]);
  const before = scenes.map((scene) => scene.source.dependencyUrls);
  expect(before).toEqual([[], []]);
  for (const scene of scenes) scene.update(0.1);
  await finished.promise;
  expect(scenes.map((scene) => scene.source.dependencyUrls)).toEqual([
    [`${base}a.ts`, `${base}common.ts`],
    [`${base}b.ts`, `${base}common.ts`],
  ]);
  expect(before).toEqual([[], []]);
});

it("includes module-initialization imports for every execution using a cached helper", async () => {
  const loader = serve({
    "scene.glts": `import "./helper.ts";`,
    "helper.ts": `await import("./initialized.ts");`,
    "initialized.ts": `export const value = 1;`,
  });
  const first = await loader.loadAsync(`${base}scene.glts`);
  const second = await loader.loadAsync(`${base}scene.glts`);
  expect([first.source.dependencyUrls, second.source.dependencyUrls]).toEqual([
    [`${base}helper.ts`, `${base}initialized.ts`],
    [`${base}helper.ts`, `${base}initialized.ts`],
  ]);
});

it("replaces dependencies on root and child reload while preserving earlier snapshots", async () => {
  const sources = {
    "scene.glts": `import { scene, gltsLoader } from "@drawcall/glts";
      scene.add(await gltsLoader.loadAsync("./child.glts"));`,
    "child.glts": `import "./old.ts"; import { loadingManager } from "@drawcall/glts";
      loadingManager.itemStart("${base}old.png"); loadingManager.itemEnd("${base}old.png");`,
    "old.ts": `export const value = 1;`,
    "new.ts": `export const value = 2;`,
  };
  const loader = serve(sources);
  const scene = await loader.loadAsync(`${base}scene.glts`);
  const source = scene.source;
  const before = source.dependencyUrls;
  sources["child.glts"] = `import "./new.ts"; import { loadingManager } from "@drawcall/glts";
    loadingManager.itemStart("${base}new.png"); loadingManager.itemEnd("${base}new.png");`;
  await loader.reload(`${base}child.glts`);
  const afterChild = scene.source.dependencyUrls;
  expect(scene.source).toBe(source);
  expect(afterChild).toEqual([`${base}child.glts`, `${base}new.png`, `${base}new.ts`]);
  expect(before).toEqual([`${base}child.glts`, `${base}old.png`, `${base}old.ts`]);
  sources["scene.glts"] = `import "./old.ts"; throw new Error("rebuild failed");`;
  await expect(loader.reload(`${base}scene.glts`)).rejects.toMatchObject({ phase: "evaluate", cause: { message: "rebuild failed" } });
  expect(scene.source).toBe(source);
  expect(scene.source.dependencyUrls).toEqual(afterChild);
  sources["scene.glts"] = "";
  await loader.reload(`${base}scene.glts`);
  expect(scene.source).not.toBe(source);
  expect(scene.source.dependencyUrls).toEqual([]);
  expect(source.dependencyUrls).toEqual(afterChild);
  expect(afterChild).toEqual([`${base}child.glts`, `${base}new.png`, `${base}new.ts`]);
});

it("records caught missing file imports without treating packages as file dependencies", async () => {
  const loader = serve({
    "scene.glts": `await import("./missing.ts").catch(() => {});
      await import("missing-package").catch(() => {});`,
  });
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(scene.source.dependencyUrls).toEqual([`${base}missing.ts`]);
});

it("retains file dependencies when the host serves their contents through blob URLs", async () => {
  const loader = serve({ "scene.glts": requestResource });
  loader.manager.setURLModifier((url) => url.endsWith("bark.png") ? "blob:https://assets.test/texture" : url);
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(scene.source.dependencyUrls).toEqual([`${base}bark.png`]);
});

it.each([false, true])("keeps readonly source metadata after disposal but not on clones (instanced: %s)", async (instanced) => {
  const loader = serve({
    "scene.glts": `import "./helper.ts";
      import { onMatrixUpdateAt } from "@drawcall/glts"; onMatrixUpdateAt(() => {});`,
    "helper.ts": "",
  });
  const scene = await (instanced
    ? loader.loadInstancesAsync(`${base}scene.glts`, 2)
    : loader.loadAsync(`${base}scene.glts`));
  const source = scene.source;
  const clone = scene.clone();
  expect(clone).not.toHaveProperty("source");
  expect(Reflect.set(scene, "source", {})).toBe(false);
  expect(Reflect.set(source, "url", "https://other.test/scene.glts")).toBe(false);
  expect(Reflect.set(source, "dependencyUrls", [])).toBe(false);
  scene.dispose();
  expect(scene.source).toBe(source);
  expect(scene.source.url).toBe(`${base}scene.glts`);
  expect(scene.source.dependencyUrls).toEqual([`${base}helper.ts`]);
});
