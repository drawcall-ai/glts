import { afterEach, expect, it, vi } from "vitest";
import { ScriptModules } from "../../src/modules/scripts.js";
import { ModuleBridge } from "../../src/modules/bridge.js";
import { ModuleURLStore } from "../../src/modules/urls.js";
import type { GLTSFetch } from "../../src/types.js";

const bridges: ModuleBridge[] = [];
afterEach(() => bridges.splice(0).forEach((bridge) => bridge.dispose()));

function modules(fetch: GLTSFetch): ScriptModules {
  const moduleURLs = new ModuleURLStore();
  const bridge = new ModuleBridge(moduleURLs);
  bridges.push(bridge);
  return new ScriptModules({
    fetch, moduleURLs, bridge, threeRevision: "185", cdnURL: new URL("https://cdn.test/")
  });
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const url = "https://example.test/scene.glts";

it("invalidates only the changed source without fetching until preparation", async () => {
  const fetch = vi.fn<GLTSFetch>().mockResolvedValue(new Response('const version = 1'));
  const scripts = modules(fetch);
  const first = await scripts.prepareScript(url);
  fetch.mockResolvedValue(new Response('const other = 1'));
  const other = await scripts.prepareScript(`${url}?other`);
  scripts.invalidateScript(url);
  scripts.invalidateScript("https://example.test/unknown.glts");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await scripts.prepareScript(`${url}?other`)).toBe(other);
  fetch.mockResolvedValue(new Response('const version = 2'));
  expect(await scripts.prepareScript(url)).not.toBe(first);
  expect(fetch).toHaveBeenLastCalledWith(url, { cache: "no-cache" });
});

it.each([false, true])("does not cache an invalidated pending preparation (reload: %s)", async (reload) => {
  const pending = deferredResponse();
  const fetch = vi.fn<GLTSFetch>().mockReturnValueOnce(pending.promise)
    .mockImplementation(async () => new Response('const version = 2'));
  const scripts = modules(fetch);
  const old = scripts.prepareScript(url, { reload });
  scripts.invalidateScript(url);
  const current = await scripts.prepareScript(url);
  pending.resolve(new Response('const version = 1'));
  const stale = await old;
  scripts.cacheScript(url, stale);
  expect(await scripts.prepareScript(url)).toBe(current);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("invalidates cached redirect aliases and rejects a pending redirect to an invalidated URL", async () => {
  const redirectedURL = "https://example.test/redirected.glts";
  const response = (version: number) => {
    const result = new Response(`const version = ${version}`);
    Object.defineProperty(result, "url", { value: redirectedURL });
    return result;
  };
  const fetch = vi.fn<GLTSFetch>().mockImplementation(async () => response(1));
  const scripts = modules(fetch);
  const first = await scripts.prepareScript(url);
  expect(await scripts.prepareScript(redirectedURL)).toBe(first);
  scripts.invalidateScript(redirectedURL);
  fetch.mockImplementation(async () => response(2));
  expect(await scripts.prepareScript(url)).not.toBe(first);

  const pending = deferredResponse();
  fetch.mockReturnValueOnce(pending.promise);
  const alias = "https://example.test/unknown-redirect.glts";
  const old = scripts.prepareScript(alias);
  scripts.invalidateScript(redirectedURL);
  pending.resolve(response(2));
  await old;
  fetch.mockImplementation(async () => response(3));
  const current = await scripts.prepareScript(alias);
  expect(current.source).toContain("3");
  expect(fetch).toHaveBeenLastCalledWith(alias, { cache: "no-cache" });
  expect(await scripts.prepareScript(redirectedURL)).toBe(current);
});

it("keeps newer and unrelated preparations coalesced when an invalidated fetch fails", async () => {
  const oldResponse = deferredResponse();
  const newResponse = deferredResponse();
  const otherResponse = deferredResponse();
  const fetch = vi.fn<GLTSFetch>()
    .mockReturnValueOnce(oldResponse.promise)
    .mockReturnValueOnce(otherResponse.promise)
    .mockReturnValueOnce(newResponse.promise);
  const scripts = modules(fetch);
  const old = scripts.prepareScript(url);
  const other = scripts.prepareScript(`${url}?other`);
  scripts.invalidateScript(url);
  const current = scripts.prepareScript(url);
  oldResponse.resolve(new Response("unavailable", { status: 503 }));
  await expect(old).rejects.toMatchObject({ phase: "fetch" });
  const coalesced = scripts.prepareScript(url);
  const otherCoalesced = scripts.prepareScript(`${url}?other`);
  expect(fetch).toHaveBeenCalledTimes(3);
  newResponse.resolve(new Response("const version = 2"));
  otherResponse.resolve(new Response("const other = 1"));
  expect(await coalesced).toBe(await current);
  expect(await otherCoalesced).toBe(await other);
});
