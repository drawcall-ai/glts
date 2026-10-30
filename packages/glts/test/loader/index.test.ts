import { LoadingManager, Mesh } from "three";
import { color } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { afterEach, expect, it, vi } from "vitest";

import { GLTSLoader } from "../../src/loader/index.js";
import { base, deferred, serve } from "./fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shares the host's Three, WebGPU, and TSL modules without fetching them", async () => {
  const fetch = vi.fn(async () => new Response(`
    import { Mesh } from "three";
    import { MeshBasicNodeMaterial } from "three/webgpu";
    import { color } from "three/tsl";
    import { scene } from "@drawcall/glts";
    const dynamic = await import("three/webgpu");
    scene.userData.modules = { Mesh, MeshBasicNodeMaterial, color, dynamic: dynamic.MeshBasicNodeMaterial };
  `));
  vi.stubGlobal("fetch", fetch);
  const loader = new GLTSLoader(new LoadingManager());
  try {
    const scene = await loader.loadAsync("https://assets.test/scene.glts");
    expect(scene.userData.modules).toEqual({ Mesh, MeshBasicNodeMaterial, color, dynamic: MeshBasicNodeMaterial });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    loader.dispose();
  }
});

it("fetches scripts past the HTTP cache with the loader's request header and credentials", async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push(init);
    return new Response(null, { status: 404 });
  });
  const loader = new GLTSLoader(new LoadingManager());
  loader.setRequestHeader({ "x-test": "header" });
  loader.setWithCredentials(true);
  await expect(loader.loadAsync("https://assets.test/scene.glts")).rejects.toMatchObject({ phase: "fetch" });
  loader.dispose();
  expect(requests.map(({ cache, credentials, headers }) => ({
    cache,
    credentials,
    header: new Headers(headers).get("x-test")
  }))).toEqual([{ cache: "no-cache", credentials: "include", header: "header" }]);
});

it("rejects a relative URL without a page to resolve it against, but loads absolute ones", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
  const loader = new GLTSLoader(new LoadingManager());
  await expect(loader.loadAsync("scene.glts")).rejects.toThrow("A relative URL needs document.baseURI or location.href");
  await expect(loader.setPath("https://assets.test/").loadAsync("scene.glts")).rejects.toMatchObject({ phase: "fetch" });
  loader.dispose();
});

it("shares the host environment with scripts, static and dynamic helpers, nested scenes, and CDN modules", async () => {
  const sources: Record<string, string> = {
    "/scene.glts": `
      import { scene, gltsLoader } from "@drawcall/glts";
      import { env as helper } from "./helper.ts";
      import { env as packageEnv } from "probe";
      scene.userData.envs = [import.meta.env, helper, (await import("./dynamic.ts")).env, packageEnv];
      scene.add(await gltsLoader.loadAsync("./child.glts"));
    `,
    "/helper.ts": "export const env = import.meta.env;",
    "/dynamic.ts": "export const env = import.meta.env;",
    "/child.glts": `import { scene } from "@drawcall/glts"; scene.userData.env = import.meta.env;`,
    "/probe": "export const env = import.meta.env;",
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const source = sources[new URL(String(input)).pathname];
    return source === undefined ? new Response(null, { status: 404 }) : new Response(source);
  });
  for (const production of [false, true]) {
    const env = { MODE: production ? "production" : "development", DEV: !production, PROD: production, VITE_NAME: "asset" };
    const expected = { ...env };
    const loader = new GLTSLoader(new LoadingManager(), { env, cdnURL: "https://cdn.test/" });
    env.VITE_NAME = "changed after construction";
    try {
      const scene = await loader.loadAsync("https://assets.test/scene.glts");
      expect(scene.userData.envs).toEqual([expected, expected, expected, expected]);
      expect(scene.children[0]?.userData.env).toEqual(expected);
    } finally {
      loader.dispose();
    }
  }
});

it("shares a host helper namespace while retaining its source graph and package provenance", async () => {
  const initialized = vi.fn();
  const shared = { texture: {} };
  const sources = {
    "scene.glts": `import { scene } from "@drawcall/glts";
      import { shared } from "./textures.ts"; scene.userData.shared = shared;`,
    "textures.ts": `import "three/webgpu"; import "./defaults.ts";
      import { initialized } from "library"; initialized(); export const shared = undefined;`,
    "defaults.ts": `export const quality = 1;`,
  };
  const loader = serve(sources, { initialized }, { [`${base}textures.ts`]: { shared } });
  const scenes = await Promise.all([1, 2].map((variant) => loader.loadAsync(`${base}scene.glts?variant=${variant}`)));
  expect(initialized).not.toHaveBeenCalled();
  for (const scene of scenes) {
    expect(scene.userData.shared).toBe(shared);
    expect(scene.source.dependencyUrls).toEqual([`${base}defaults.ts`, `${base}textures.ts`]);
    expect(scene.source.packages).toEqual(["@drawcall/glts", "library", "three"]);
  }
  sources["defaults.ts"] = "export const quality = 2;";
  await loader.reload(`${base}defaults.ts`);
  expect(scenes.map((scene) => scene.userData.shared)).toEqual([shared, shared]);
  expect(initialized).not.toHaveBeenCalled();
  const ordinary = serve(sources, { initialized });
  expect((await ordinary.loadAsync(`${base}scene.glts`)).userData.shared).toBeUndefined();
  expect(initialized).toHaveBeenCalledOnce();
});


it("gives concurrent executions of query variants their own import.meta and source", async () => {
  const entered = deferred();
  const released = deferred();
  let started = 0;
  const loader = serve({
    "scene.glts": `import { scene, onFrame } from "@drawcall/glts";
      import { pause } from "library";
      import "./helper.ts";
      const meta = import.meta;
      const before = scene.source;
      await pause();
      scene.userData = { before, after: scene.source, meta, same: meta === import.meta };
      onFrame(() => { scene.name = import.meta.url; });`,
    "helper.ts": `export {};`,
  }, {
    pause: () => { if (++started === 2) entered.resolve(); return released.promise; },
  });
  const urls = ["?variant=1", "?variant=2"].map((query) => `${base}scene.glts${query}`);
  const pending = Promise.all(urls.map((url) => loader.loadAsync(url)));
  await entered.promise;
  released.resolve();
  const scenes = await pending;
  for (const [index, scene] of scenes.entries()) {
    expect(scene.url).toBe(urls[index]);
    expect(scene.source.url).toBe(urls[index]);
    expect(scene.source.dependencyUrls).toEqual([`${base}helper.ts`]);
    expect(scene.userData).toMatchObject({ before: scene.source, after: scene.source, meta: { url: urls[index] }, same: true });
    scene.update(0);
    expect(scene.name).toBe(urls[index]);
  }
  expect(scenes[0]?.userData.meta).not.toBe(scenes[1]?.userData.meta);
});

it("lists only the requested variant of a nested script, whichever variant linked first", async () => {
  const loader = serve({
    "child.glts": `import { scene } from "@drawcall/glts"; scene.name = import.meta.url;`,
    "parent.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./child.glts?seed=2"));`,
  });
  await loader.loadAsync(`${base}child.glts?seed=1`);
  const parent = await loader.loadAsync(`${base}parent.glts`);
  expect(parent.source.dependencyUrls).toEqual([`${base}child.glts?seed=2`]);
});

it("shares package exports and explicit host overrides with CDN packages", async () => {
  const observed: unknown[] = [];
  const loader = serve({
    "scene.glts": `import { work } from "https://cdn.test/library.js"; work();`,
    "library.js": `import { GLTSLoader, marker } from "@drawcall/glts";
      import { record } from "library";
      export function work() {
        record(GLTSLoader);
        record(marker);
      }`,
  }, { record: (value: unknown) => { observed.push(value); } }, {
    "@drawcall/glts": { marker: "host override" },
  });
  await loader.loadAsync(`${base}scene.glts`);
  expect(observed).toEqual([GLTSLoader, "host override"]);
});
