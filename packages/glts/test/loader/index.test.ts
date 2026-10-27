import { LoadingManager, Mesh } from "three";
import { color } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { afterEach, expect, it, vi } from "vitest";

import { GLTSLoader } from "../../src/loader/index.js";

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
