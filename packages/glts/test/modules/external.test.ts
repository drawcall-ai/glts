import { expect, it, vi } from "vitest";
import * as physics from "@drawcall/physics";
import { LoadingManager } from "three";

import { Execution } from "../../src/scene/execution.js";
import { ExternalModules } from "../../src/modules/external.js";
import { GLTSLoader } from "../../src/loader/index.js";
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

it("finishes dependencies before failure cleanup and does not start later imports", async () => {
  const urls = new ModuleURLStore();
  const release = vi.spyOn(urls, "release");
  const bridge = new ModuleBridge(urls);
  const world = new physics.AuthoringWorld();
  const execution = new Execution([], [], undefined, () => Promise.resolve(world));
  const loader = new GLTSLoader(new LoadingManager());
  const context = execution.context({
    gltsLoader: loader,
    loadingManager: new LoadingManager(),
    isPreview: false,
  });
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
      if (name === "helper") {
        return new Response('export { RigidBody } from "@drawcall/physics";');
      }
      if (name === "missing") return new Response("", { status: 404 });
      throw new Error(`Unexpected fetch: ${input}`);
    },
  }).forContext(context);

  try {
    await expect(external.prepareImport("root", "https://cdn.test/entry.glts", [])).rejects.toThrow("404");
    expect(requests).toEqual(["root", "helper", "missing"]);
    const helper = await external.prepareImport("helper", "https://cdn.test/entry.glts", []);
    execution.dispose();
    expect(release).toHaveBeenCalledWith(helper.url);
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
    execution.dispose();
    loader.dispose();
    world.dispose();
    bridge.dispose();
  }
});
