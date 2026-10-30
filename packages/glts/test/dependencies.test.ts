import { LoadingManager } from "three";
import { expect, it, vi } from "vitest";

import { sourceHash } from "../src/linker/provenance.js";
import { GLTSLoader } from "../src/loader/index.js";
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
      import { capture } from "library"; capture(scene.source);
      scene.add(await gltsLoader.loadAsync("./child.glts"));
      ${requestResource}
      loadingManager.itemStart(resource); loadingManager.itemEnd(resource);
      loadingManager.itemStart("data:text/plain,inline"); loadingManager.itemEnd("data:text/plain,inline");`,
    "helper.ts": `import "./shared.ts"; import "three";`,
    "shared.ts": `import "three/webgpu"; export const value = 1;`,
    "child.glts": `import "./child-helper.ts"; ${requestResource}`,
    "child-helper.ts": `export const value = 2;`,
  }, { capture: (source: GLTSSource) => {
    captured = source;
    snapshots.push(source.dependencyUrls);
  } });
  loader.manager.setURLModifier((url) => url.endsWith("bark.png") ? `${base}textures/bark.png?v=2#part` : url);
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(snapshots[0]).toEqual([`${base}helper.ts`, `${base}shared.ts`]);
  expect(scene.source.dependencyUrls).toEqual([
    "child-helper.ts", "child.glts", "helper.ts", "shared.ts", "textures/bark.png?v=2",
  ].map((path) => base + path));
  expect(scene.source).toBe(captured);
  expect(scene.source.packages).toEqual(["@drawcall/glts", "library", "three"]);
  expect(Object.isFrozen(scene.source.packages)).toBe(true);
  expect(Object.isFrozen(scene.source.dependencyUrls)).toBe(true);
  expect(Object.isFrozen(snapshots[0])).toBe(true);
});

it("records a resource resolved for a host-loaded value without requesting it", async () => {
  const loader = serve({
    "scene.glts": `import { loadingManager } from "@drawcall/glts";
      loadingManager.resolveURL(new URL("./shared.png", import.meta.url).href);`,
  });
  loader.manager.setURLModifier((url) => url.endsWith("shared.png") ? `${base}textures/shared.png?v=2` : url);
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(scene.source.dependencyUrls).toEqual([`${base}textures/shared.png?v=2`]);
});

it("shares later dynamic file imports between executions of one cached script", async () => {
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
  // Query variants share a linked script, so its dynamic imports count for each of them: never stale, at most conservative.
  const union = [`${base}a.ts`, `${base}b.ts`, `${base}common.ts`];
  expect(scenes.map((scene) => scene.source.dependencyUrls)).toEqual([union, union]);
  expect(before).toEqual([[], []]);
});

it("records a dynamic import that runs after its script was reloaded into the old source only", async () => {
  const release = deferred();
  const finished = deferred();
  const sources = {
    "scene.glts": `import { pending, finish } from "library";
      pending.then(() => import("./late.ts")).then(finish);`,
    "late.ts": `export const value = 1;`,
  };
  const loader = serve(sources, { pending: release.promise, finish: finished.resolve });
  const scene = await loader.loadAsync(`${base}scene.glts`);
  const old = scene.source;
  sources["scene.glts"] = "";
  await loader.reload(`${base}scene.glts`);
  release.resolve();
  await finished.promise;
  expect(old.dependencyUrls).toEqual([`${base}late.ts`]);
  expect(scene.source.dependencyUrls).toEqual([]);
});

it.each(["helper", "package"])("includes initialization imports for every execution using a cached %s", async (kind) => {
  const extension = kind === "helper" ? "ts" : "js";
  const path = `shared.${extension}`;
  const initialized = `initialized.${extension}`;
  const loader = serve({
    "scene.glts": `import "${kind === "helper" ? `./${path}` : `https://cdn.test/${path}`}";`,
    [path]: `await import("./${initialized}");`,
    [initialized]: `export const value = 1;`,
  });
  const first = await loader.loadAsync(`${base}scene.glts`);
  const second = await loader.loadAsync(`${base}scene.glts`);
  for (const scene of [first, second]) {
    expect(scene.source.dependencyUrls).toEqual(kind === "helper" ? [initialized, path].map((file) => base + file) : []);
    const runtimeModules = kind === "package" ? [initialized, path].map((file) => `https://cdn.test/${file}`) : [];
    expect(Object.keys(scene.source.moduleHashes)).toEqual(runtimeModules);
    expect(scene.source.runtimeModules).toEqual(runtimeModules);
  }
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

it("discovers package roots through helpers and literal dynamic imports before generation", async () => {
  const loader = serve({
    "scene.glts": `import { scene } from "@drawcall/glts";
      import { generate } from "./generator.ts";
      scene.userData.before = scene.source.packages;
      await generate();`,
    "generator.ts": `import "@scope/generator/mesh";
      export async function generate() { await import("compression/codec"); }`,
  }, {}, { "@scope/generator/mesh": {}, "compression/codec": {} });
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(scene.userData.before).toEqual(["@drawcall/glts", "@scope/generator", "compression"]);
  expect(scene.source.packages).toEqual(scene.userData.before);
});

it("retains remote versions and content separately from installed package roots", async () => {
  const loader = serve({
    "scene.glts": `import { scene } from "@drawcall/glts";
      import { value } from "cdn-only@1"; scene.name = value; scene.userData.source = scene.source;`,
    "cdn-only@1": `export { value } from "./version-1.js";`,
    "version-1.js": `export const value = "remote";`,
  });
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(scene.name).toBe("remote");
  expect(scene.userData.source).toBe(scene.source);
  expect(scene.source.packages).toEqual(["@drawcall/glts"]);
  expect(scene.source.dependencyUrls).toEqual([]);
  const modules = Object.entries(scene.source.moduleHashes);
  expect(modules.map(([url]) => new URL(url).pathname)).toEqual(["/cdn-only@1", "/version-1.js"]);
  expect(modules.every(([, hash]) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  expect(Object.isFrozen(scene.source.moduleHashes)).toBe(true);
});

it("records a resource's resolved identity without remapping it or retaining its logical progress URL", async () => {
  vi.stubGlobal("ProgressEvent", class extends Event {});
  const alias = `${base}logical.bin`;
  const resolved = `${base}physical.bin?signature=one`;
  const loader = serve({
    "scene.glts": `import { scene, loadingManager } from "@drawcall/glts";
      import { FileLoader } from "three";
      const url = new URL("./logical.bin", import.meta.url).href;
      loadingManager.itemStart(url);
      scene.userData.value = await new FileLoader(loadingManager).loadAsync(url);
      loadingManager.itemEnd(url);`,
    "physical.bin": "resolved bytes",
  });
  const modifier = vi.fn((url: string) => {
    if (url === resolved) throw new Error("URL modifier applied twice");
    return url === alias ? resolved : url;
  });
  loader.manager.setURLModifier(modifier);
  const scene = await loader.loadAsync(`${base}scene.glts`);
  expect(scene.userData.value).toBe("resolved bytes");
  expect(scene.source.dependencyUrls).toEqual([resolved]);
  expect(modifier.mock.calls).toEqual([[`${base}scene.glts`], [alias]]);
});

it("exposes only frozen source metadata at the redirected URL without its query", async () => {
  let contextual: unknown;
  const loader = serve({}, { capture: (source: unknown) => { contextual = source; } });
  vi.stubGlobal("fetch", async () => {
    const response = new Response(`import { scene } from "@drawcall/glts"; import { capture } from "library"; capture(scene.source);`);
    Object.defineProperty(response, "url", { value: `${base}redirected/scene.glts?version=2` });
    return response;
  });
  const scene = await loader.loadAsync(`${base}original.glts`);
  expect(Reflect.ownKeys(scene.source).sort()).toEqual(["dependencyUrls", "moduleHashes", "packages", "runtimeModules", "url"]);
  expect(Object.isFrozen(scene.source)).toBe(true);
  expect(scene.source.url).toBe(`${base}redirected/scene.glts`);
  expect(contextual).toBe(scene.source);
  expect(scene.url).toBe(`${base}original.glts`);
});

it("loads supplied versioned namespaces and requires their identities to read provenance", async () => {
  const fetch = vi.fn(async () => new Response(`import { scene } from "@drawcall/glts";
    import { value } from "generator@1"; scene.userData.value = value;`));
  vi.stubGlobal("fetch", fetch);
  const url = "https://assets.test/scene.glts";
  for (const moduleSources of [undefined, { "generator@1": { packages: [], moduleHashes: {} } }]) {
    const loader = new GLTSLoader(new LoadingManager(), { modules: { "generator@1": { value: 1 } }, ...(moduleSources ? { moduleSources } : {}) });
    try {
      const scene = await loader.loadAsync(url);
      expect(scene.userData.value).toBe(1);
      expect(scene.source.runtimeModules).toEqual([]);
      for (const read of [() => scene.source.moduleHashes, () => scene.source.packages]) {
        expect(read).toThrow("requires moduleSources with source-content hashes");
      }
    } finally { loader.dispose(); }
  }
  const identities: string[] = [];
  for (const value of [1, 2]) {
    const hash = await sourceHash(`export const value = ${value};`);
    const modules = { "https://cdn.test/generator@1.js": hash };
    const moduleSources = { "generator@1": { packages: [], moduleHashes: modules } };
    const loader = new GLTSLoader(new LoadingManager(), { modules: { "generator@1": { value } }, moduleSources });
    try {
      fetch.mockClear();
      const scene = await loader.loadAsync(url);
      expect(scene.userData.value).toBe(value);
      expect(scene.source.moduleHashes).toEqual(modules);
      expect(scene.source.runtimeModules).toEqual([]);
      expect(fetch).toHaveBeenCalledOnce();
      identities.push(hash);
    } finally { loader.dispose(); }
  }
  expect(identities[0]).not.toBe(identities[1]);
});

it("loads namespaces whose bundled hashes conflict, in one script or across a helper and the script, and reports the conflict only where module hashes are read", async () => {
  const remote = "https://cdn.test/shared.js";
  const sources: Record<string, string> = {
    "together.glts": `import "a@1"; import "b@1";`,
    "split.glts": `import "./helper.ts"; import "b@1";`,
    "helper.ts": `import "a@1";`,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => new Response(sources[new URL(String(input)).pathname.slice(1)]));
  for (const name of ["together.glts", "split.glts"]) {
    const loader = new GLTSLoader(new LoadingManager(), {
      modules: { "a@1": {}, "b@1": {} },
      moduleSources: {
        "a@1": { packages: ["a"], moduleHashes: { [remote]: "a" } },
        "b@1": { packages: ["b"], moduleHashes: { [remote]: "b" } },
      },
    });
    try {
      const scene = await loader.loadAsync(`https://assets.test/${name}`);
      expect(() => scene.source.moduleHashes).toThrow(`Conflicting module content hashes for ${remote}`);
      expect(scene.source.packages).toEqual(["@drawcall/glts", "a", "b"]);
    } finally { loader.dispose(); }
  }
});

it("retains runtime origins even when a bundled namespace contains the same remote URL", async () => {
  const url = "https://assets.test/scene.glts";
  const remote = "https://cdn.test/generator.js";
  let content = 'export const value = "first";';
  const hash = await sourceHash(content);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => new Response(String(input) === url
    ? `import { scene } from "@drawcall/glts"; import { value as bundled } from "generator@1";
       import { value } from "${remote}"; scene.name = bundled + ":" + value;`
    : content));
  for (const value of ["first", "changed"]) {
    content = `export const value = "${value}";`;
    const loader = new GLTSLoader(new LoadingManager(), {
      modules: { "generator@1": { value: "first" } },
      moduleSources: { "generator@1": { packages: [], moduleHashes: { [remote]: hash } } },
    });
    try {
      const scene = await loader.loadAsync(url);
      expect(scene.name).toBe(`first:${value}`);
      expect(scene.source.runtimeModules).toEqual([remote]);
      if (value === "first") expect(scene.source.moduleHashes[remote]).toBe(hash);
      else expect(() => scene.source.moduleHashes).toThrow(`Conflicting module content hashes for ${remote}`);
      expect(loader.moduleSources["generator@1"]?.moduleHashes[remote]).toBe(hash);
    } finally { loader.dispose(); }
  }
});
