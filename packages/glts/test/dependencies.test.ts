import { expect, it } from "vitest";

import { getGLTSContext } from "../src/context.js";
import type { GLTSContext } from "../src/types.js";
import { base, serve } from "./loader/fixture.js";

const capture = `import { capture } from "library"; capture();`;
const requestResource = `import { loadingManager } from "@drawcall/glts";
  const resource = loadingManager.resolveURL(new URL("./bark.png", import.meta.url).href);
  loadingManager.itemStart(resource); loadingManager.itemEnd(resource);`;

it("reports transitive helper, nested GLTS, and resource files as frozen snapshots", async () => {
  const contexts: GLTSContext[] = [];
  const snapshots: (readonly string[])[] = [];
  const loader = serve({
    "scene.glts": `import "./helper.ts";
      import { scene, gltsLoader } from "@drawcall/glts";
      ${capture}
      scene.add(await gltsLoader.loadAsync("./child.glts"));
      ${requestResource}
      loadingManager.itemStart(resource); loadingManager.itemEnd(resource);
      loadingManager.itemStart("data:text/plain,inline"); loadingManager.itemEnd("data:text/plain,inline");`,
    "helper.ts": `import "./shared.ts"; import "three";`,
    "shared.ts": `export const value = 1;`,
    "child.glts": `import "./child-helper.ts"; ${requestResource}`,
    "child-helper.ts": `export const value = 2;`,
  }, { capture: () => {
    const context = getGLTSContext();
    contexts.push(context);
    snapshots.push(context.dependencies);
  } });
  loader.manager.setURLModifier((url) => url.endsWith("bark.png") ? `${base}textures/bark.png?v=2#part` : url);
  await loader.loadAsync(`${base}scene.glts`);
  expect(snapshots[0]).toEqual([`${base}helper.ts`, `${base}shared.ts`]);
  expect(contexts[0]?.dependencies).toEqual([
    "bark.png", "child-helper.ts", "child.glts", "helper.ts", "shared.ts", "textures/bark.png?v=2",
  ].map((path) => base + path));
  expect(Object.isFrozen(contexts[0]?.dependencies)).toBe(true);
  expect(Object.isFrozen(snapshots[0])).toBe(true);
});

it("keeps dynamic file imports separate between executions sharing cached source", async () => {
  const contexts: GLTSContext[] = [];
  let next = 0;
  const loader = serve({
    "scene.glts": `import { choice } from "library"; ${capture}
      await import(choice());`,
    "a.ts": `import "./common.ts";`,
    "b.ts": `import "./common.ts";`,
    "common.ts": `export const value = 1;`,
  }, {
    choice: () => next++ === 0 ? "./a.ts" : "./b.ts",
    capture: () => { contexts.push(getGLTSContext()); },
  });
  await Promise.all([loader.loadAsync(`${base}scene.glts`), loader.loadAsync(`${base}scene.glts`)]);
  expect(contexts.map((context) => context.dependencies)).toEqual([
    [`${base}a.ts`, `${base}common.ts`],
    [`${base}b.ts`, `${base}common.ts`],
  ]);
});

it("includes module-initialization imports for every execution using a cached helper", async () => {
  const contexts: GLTSContext[] = [];
  const loader = serve({
    "scene.glts": `import "./helper.ts"; ${capture}`,
    "helper.ts": `await import("./initialized.ts");`,
    "initialized.ts": `export const value = 1;`,
  }, { capture: () => { contexts.push(getGLTSContext()); } });
  await loader.loadAsync(`${base}scene.glts`);
  await loader.loadAsync(`${base}scene.glts`);
  expect(contexts.map((context) => context.dependencies)).toEqual([
    [`${base}helper.ts`, `${base}initialized.ts`],
    [`${base}helper.ts`, `${base}initialized.ts`],
  ]);
});

it("replaces dependencies on root and child reload while preserving earlier snapshots", async () => {
  const contexts: GLTSContext[] = [];
  const sources = {
    "scene.glts": `import { scene, gltsLoader } from "@drawcall/glts";
      ${capture} scene.add(await gltsLoader.loadAsync("./child.glts"));`,
    "child.glts": `import "./old.ts"; import { loadingManager } from "@drawcall/glts";
      loadingManager.itemStart("${base}old.png"); loadingManager.itemEnd("${base}old.png");`,
    "old.ts": `export const value = 1;`,
    "new.ts": `export const value = 2;`,
  };
  const loader = serve(sources, { capture: () => { contexts.push(getGLTSContext()); } });
  await loader.loadAsync(`${base}scene.glts`);
  const before = contexts[0]?.dependencies;
  sources["child.glts"] = `import "./new.ts"; import { loadingManager } from "@drawcall/glts";
    loadingManager.itemStart("${base}new.png"); loadingManager.itemEnd("${base}new.png");`;
  await loader.reload(`${base}child.glts`);
  expect(contexts[0]?.dependencies).toEqual([`${base}child.glts`, `${base}new.png`, `${base}new.ts`]);
  expect(before).toEqual([`${base}child.glts`, `${base}old.png`, `${base}old.ts`]);
  sources["scene.glts"] = capture;
  await loader.reload(`${base}scene.glts`);
  expect(contexts[1]?.dependencies).toEqual([]);
});

it("records caught missing file imports without treating packages as file dependencies", async () => {
  const contexts: GLTSContext[] = [];
  const loader = serve({
    "scene.glts": `${capture}
      await import("./missing.ts").catch(() => {});
      await import("missing-package").catch(() => {});`,
  }, { capture: () => { contexts.push(getGLTSContext()); } });
  await loader.loadAsync(`${base}scene.glts`);
  expect(contexts[0]?.dependencies).toEqual([`${base}missing.ts`]);
});

it("retains file dependencies when the host serves their contents through blob URLs", async () => {
  const contexts: GLTSContext[] = [];
  const loader = serve({ "scene.glts": `${capture} ${requestResource}` }, {
    capture: () => { contexts.push(getGLTSContext()); },
  });
  loader.manager.setURLModifier((url) => url.endsWith("bark.png") ? "blob:https://assets.test/texture" : url);
  await loader.loadAsync(`${base}scene.glts`);
  expect(contexts[0]?.dependencies).toEqual([`${base}bark.png`]);
});
