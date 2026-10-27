import { expect, it, vi } from "vitest";

import { GLTSLoader } from "../../src/loader/index.js";
import { getGLTSSource } from "../../src/execution/current.js";
import type { GLTSSource } from "../../src/types.js";
import { base, deferred, serve } from "../loader/fixture.js";

it("keeps concurrent scripts distinct across awaits without leaking their execution to the caller", async () => {
  const started = deferred();
  const release = deferred();
  const observed: string[] = [];
  let entries = 0;
  const library = {
    enter: () => {
      observed.push(getGLTSSource().url);
      entries += 1;
      if (entries === 2) started.resolve();
      return release.promise;
    },
    capture: () => { observed.push(getGLTSSource().url); },
  };
  const source = `import { enter, capture } from "library"; await enter(); capture();`;
  const loader = serve({ "a.glts": source, "b.glts": source }, library);
  const loads = Promise.all([loader.loadAsync(`${base}a.glts`), loader.loadAsync(`${base}b.glts`)]);
  await started.promise;
  expect(() => getGLTSSource()).toThrow("No GLTS execution is active");
  release.resolve();
  await loads;
  expect(observed.filter((url) => url === `${base}a.glts`)).toHaveLength(2);
  expect(observed.filter((url) => url === `${base}b.glts`)).toHaveLength(2);
  expect(() => getGLTSSource()).toThrow("No GLTS execution is active");
});

it("restores a parent script after loading a nested script", async () => {
  const observed: string[] = [];
  const loader = serve({
    "parent.glts": `import { gltsLoader, scene } from "@drawcall/glts";
      import { capture } from "library";
      capture(); scene.add(await gltsLoader.loadAsync("./child.glts")); capture();`,
    "child.glts": `import { capture } from "library"; await Promise.resolve(); capture();`,
  }, { capture: () => { observed.push(getGLTSSource().url); } });
  await loader.loadAsync(`${base}parent.glts`);
  expect(observed).toEqual([`${base}parent.glts`, `${base}child.glts`, `${base}parent.glts`]);
});

it("restores the current execution after a failed script and permits subsequent execution", async () => {
  const observed: string[] = [];
  const loader = serve({
    "bad.glts": `await Promise.resolve(); throw new Error("script failed");`,
    "good.glts": `import { capture } from "library"; capture();`,
  }, { capture: () => { observed.push(getGLTSSource().url); } });
  await expect(loader.loadAsync(`${base}bad.glts`)).rejects.toMatchObject({ phase: "evaluate", cause: { message: "script failed" } });
  expect(() => getGLTSSource()).toThrow("No GLTS execution is active");
  await loader.loadAsync(`${base}good.glts`);
  expect(observed).toEqual([`${base}good.glts`]);
});

it("exposes only frozen source metadata with the same final URL as the scene", async () => {
  let captured: GLTSSource | undefined;
  const loader = serve({}, { capture: () => {
    captured = getGLTSSource();
    expect(Reflect.ownKeys(captured).sort()).toEqual(["dependencyUrls", "url"]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(getGLTSSource()).toBe(captured);
  } });
  vi.stubGlobal("fetch", async () => {
    const response = new Response(`import { capture } from "library"; capture();`);
    Object.defineProperty(response, "url", { value: `${base}redirected/scene.glts?version=2` });
    return response;
  });
  const scene = await loader.loadAsync(`${base}original.glts`);
  expect(captured?.url).toBe(`${base}redirected/scene.glts?version=2`);
  expect(scene.source).toBe(captured);
  expect(scene.url).toBe(`${base}original.glts`);
});

it("keeps the replacement execution's scene bound to the existing node on reload", async () => {
  const sources: GLTSSource[] = [];
  const source = `import { capture } from "library";
    import { scene as root, onFrame } from "@drawcall/glts";
    import * as glts from "@drawcall/glts";
    capture();
    onFrame(() => {
      if (root !== glts.scene) throw new Error("Stale scene");
      root.userData.updated = true;
    });
    if (Object.getPrototypeOf(glts) !== null || !Object.isFrozen(glts)) throw new Error("Invalid namespace");
    const names = Object.keys(glts).sort().join();
    if (names !== "getGLTSSource,gltsLoader,instanceCount,isPreview,loadingManager,onDispose,onFrame,onMatrixUpdateAt,scene") {
      throw new Error("Unexpected script exports: " + names);
    }`;
  const loader = serve({ "scene.glts": source }, { capture: () => { sources.push(getGLTSSource()); } });
  const scene = await loader.loadAsync(`${base}scene.glts`);
  await loader.reload(`${base}scene.glts`);
  expect(sources).toHaveLength(2);
  expect(sources[1]).not.toBe(sources[0]);
  expect(scene.source).toBe(sources[1]);
  scene.update(0.1);
  expect(scene.userData.updated).toBe(true);
});

it("allows async helpers to read the calling script's source", async () => {
  const observed: string[] = [];
  const loader = serve({
    "scene.glts": `import { work } from "./helper.ts"; await work();`,
    "helper.ts": `import { getGLTSSource } from "@drawcall/glts";
      import { record } from "library";
      export async function work() {
        record(getGLTSSource().url);
        await Promise.resolve();
        record(getGLTSSource().url);
      }`,
  }, { record: (url: string) => { observed.push(url); } });
  await loader.loadAsync(`${base}scene.glts`);
  expect(observed).toEqual([`${base}scene.glts`, `${base}scene.glts`]);
});

it("lets native async packages retain source metadata without leaking the execution across their awaits", async () => {
  let retained: GLTSSource | undefined;
  let afterAwait: unknown;
  const loader = serve({
    "scene.glts": `import { work } from "library"; await work();`,
  }, {
    work: async () => {
      retained = getGLTSSource();
      await Promise.resolve();
      try { getGLTSSource(); } catch (error) { afterAwait = error; }
    },
  });
  await loader.loadAsync(`${base}scene.glts`);
  expect(retained?.url).toBe(`${base}scene.glts`);
  expect(afterAwait).toBeInstanceOf(Error);
});

it("preserves the current execution in async methods, generators, and rejected-await continuations", async () => {
  const observed: string[] = [];
  const loader = serve({
    "scene.glts": `import { capture, record } from "library";
      class Worker {
        name = "worker";
        async work() { await Promise.resolve(); capture(); return this.name; }
      }
      async function* values() {
        await Promise.resolve(); capture(); yield 1;
        await Promise.resolve(); capture(); yield 2;
      }
      record(await new Worker().work());
      for await (const value of values()) { capture(); record(String(value)); }
      try { await Promise.reject(new Error("expected")); }
      catch { capture(); }
      finally { capture(); }`,
  }, {
    capture: () => { observed.push(getGLTSSource().url); },
    record: (value: string) => { observed.push(value); },
  });
  await loader.loadAsync(`${base}scene.glts`);
  expect(observed).toEqual([
    `${base}scene.glts`, "worker",
    `${base}scene.glts`, `${base}scene.glts`, "1",
    `${base}scene.glts`, `${base}scene.glts`, "2",
    `${base}scene.glts`, `${base}scene.glts`,
  ]);
});

it("retains an async lifecycle callback's execution across its awaits", async () => {
  const finished = deferred();
  const observed: string[] = [];
  const loader = serve({
    "scene.glts": `import { onFrame } from "@drawcall/glts";
      import { capture, finish } from "library";
      onFrame(async () => {
        capture();
        await Promise.resolve();
        capture();
        finish();
      });`,
  }, {
    capture: () => { observed.push(getGLTSSource().url); },
    finish: finished.resolve,
  });
  const scene = await loader.loadAsync(`${base}scene.glts`);
  scene.update(0.1);
  expect(() => getGLTSSource()).toThrow("No GLTS execution is active");
  await finished.promise;
  expect(observed).toEqual([`${base}scene.glts`, `${base}scene.glts`]);
  expect(() => getGLTSSource()).toThrow("No GLTS execution is active");
});

it("does not assign an execution to an independently scheduled then callback", async () => {
  const release = deferred();
  const finished = deferred();
  let observed: unknown;
  const loader = serve({
    "scene.glts": `import { getGLTSSource } from "@drawcall/glts";
      import { pending, report, finish } from "library";
      pending.then(() => {
        try { report(getGLTSSource()); } catch (error) { report(error); }
        finish();
      });`,
  }, {
    pending: release.promise,
    report: (result: unknown) => { observed = result; },
    finish: finished.resolve,
  });
  await loader.loadAsync(`${base}scene.glts`);
  release.resolve();
  await finished.promise;
  expect(observed).toBeInstanceOf(Error);
  expect(observed).toHaveProperty("message", "No GLTS execution is active");
});

it("shares package exports and explicit host overrides with CDN packages", async () => {
  const observed: unknown[] = [];
  const loader = serve({
    "scene.glts": `import { work } from "https://cdn.test/library.js"; work();`,
    "library.js": `import { getGLTSSource, GLTSLoader, marker } from "@drawcall/glts";
      import { record } from "library";
      export function work() {
        record(getGLTSSource().url);
        record(GLTSLoader);
        record(marker);
      }`,
  }, { record: (value: unknown) => { observed.push(value); } }, {
    "@drawcall/glts": {
      marker: "host override",
      getGLTSSource: () => { throw new Error("Override must not replace the source getter"); },
    },
  });
  await loader.loadAsync(`${base}scene.glts`);
  expect(observed).toEqual([`${base}scene.glts`, GLTSLoader, "host override"]);
});
