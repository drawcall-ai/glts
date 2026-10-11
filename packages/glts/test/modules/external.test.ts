import { expect, it } from "vitest";

import { ExternalModules } from "../../src/modules/external.js";
import { ModuleURLStore } from "../../src/modules/urls.js";
import { ModuleBridge } from "../../src/modules/bridge.js";

it("rejects a cycle between sibling dependencies instead of waiting on both", async () => {
  const urls = new ModuleURLStore();
  const bridge = new ModuleBridge(urls);
  const sources = new Map([
    ["a", 'import "b"; import "c";'],
    ["b", 'import "c";'],
    ["c", 'import "b";'],
  ]);
  const external = new ExternalModules({
    moduleURLs: urls,
    bridge,
    threeRevision: "185",
    cdnURL: new URL("https://cdn.test/"),
    fetch: async (input) => {
      const source = sources.get(new URL(String(input)).pathname.slice(1));
      if (source === undefined) throw new Error(`Unexpected fetch: ${input}`);
      return new Response(source);
    },
  });
  try {
    await expect(external.prepareImport("a", "https://cdn.test/entry.glts", [])).rejects.toThrow(
      "Cyclic CDN modules are not supported",
    );
  } finally {
    bridge.dispose();
  }
}, 1000);

it("stops at the first failing dependency without starting later imports", async () => {
  const urls = new ModuleURLStore();
  const bridge = new ModuleBridge(urls);
  const requests: string[] = [];
  const external = new ExternalModules({
    moduleURLs: urls,
    bridge,
    threeRevision: "185",
    cdnURL: new URL("https://cdn.test/"),
    fetch: async (input) => {
      const name = new URL(String(input)).pathname.slice(1);
      requests.push(name);
      if (name === "root") {
        return new Response('import "helper"; import "missing"; import "late";');
      }
      if (name === "helper") return new Response("export const helper = 1;");
      if (name === "missing") return new Response("", { status: 404 });
      throw new Error(`Unexpected fetch: ${input}`);
    },
  });

  try {
    await expect(external.prepareImport("root", "https://cdn.test/entry.glts", [])).rejects.toThrow("404");
    expect(requests).toEqual(["root", "helper", "missing"]);
  } finally {
    bridge.dispose();
  }
});

it("imports host modules by exact specifier and sends other versions to the CDN", async () => {
  const urls = new ModuleURLStore();
  const noise = { createNoise2D: () => 0 };
  const bridge = new ModuleBridge(urls, { "simplex-noise": noise });
  const requests: string[] = [];
  const external = new ExternalModules({
    moduleURLs: urls,
    bridge,
    threeRevision: "185",
    cdnURL: new URL("https://cdn.test/"),
    fetch: async (input) => {
      requests.push(new URL(String(input)).pathname);
      return new Response("export {};");
    },
  });
  try {
    const host = await external.prepareImport("simplex-noise", "https://cdn.test/entry.glts", [], "script");
    expect(host).toBe(bridge.getHostModuleURL("simplex-noise"));
    expect(bridge.getModuleExport("simplex-noise", "createNoise2D")).toBe(noise.createNoise2D);
    await external.prepareImport("simplex-noise@4", "https://cdn.test/entry.glts", [], "script");
    expect(requests).toEqual(["/simplex-noise@4"]);
  } finally {
    bridge.dispose();
  }
});
