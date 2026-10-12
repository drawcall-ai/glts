import { LoadingManager } from "three";
import { afterEach, expect, it, vi } from "vitest";

import { GLTSLoader } from "../../src/loader/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
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
