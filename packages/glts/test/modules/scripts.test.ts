import { afterEach, expect, it } from "vitest";

import { ModuleBridge } from "../../src/modules/bridge.js";
import { ScriptModules } from "../../src/modules/scripts.js";
import { ModuleURLStore } from "../../src/modules/urls.js";

const base = "https://assets.test/";
let bridge: ModuleBridge | undefined;

afterEach(() => bridge?.dispose());

/** Script modules serving `sources` by path, recording each request. */
function serve(sources: Readonly<Record<string, string>>): { modules: ScriptModules; requests: string[] } {
  const requests: string[] = [];
  const moduleURLs = new ModuleURLStore();
  bridge = new ModuleBridge(moduleURLs);
  const modules = new ScriptModules({
    bridge,
    cdnURL: new URL("https://cdn.test/"),
    moduleURLs,
    threeRevision: "185",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname.slice(1);
      requests.push(path);
      const source = sources[path];
      return source === undefined ? new Response(null, { status: 404 }) : new Response(source);
    },
  });
  return { modules, requests };
}

it("prepares a script's helpers once each and tracks the script as their dependent", async () => {
  const { modules, requests } = serve({
    "scene.glts": `import { a } from "./a.ts"; import { b } from "./b.ts"; import { b as again } from "./b.ts";`,
    "a.ts": `import { shared } from "./shared.ts"; export const a: number = shared;`,
    "b.ts": `import { shared } from "./shared.ts"; import type { GLTSURL } from "@drawcall/glts"; export const b: GLTSURL = shared;`,
    "shared.ts": `export const shared = 1;`,
  });
  const script = await modules.prepareScript(`${base}scene.glts`);
  expect([...script.imports.keys()]).toEqual(["./a.ts", "./b.ts"]);
  expect(requests.sort()).toEqual(["a.ts", "b.ts", "scene.glts", "shared.ts"]);
  expect(modules.dependents(`${base}shared.ts`)).toEqual([`${base}scene.glts`]);
  expect(modules.dependents(`${base}other.ts`)).toEqual([]);
});

it("rejects helper cycles", async () => {
  const { modules } = serve({
    "scene.glts": `import "./a.ts";`,
    "a.ts": `import "./b.ts";`,
    "b.ts": `import "./a.ts";`,
  });
  await expect(modules.prepareScript(`${base}scene.glts`)).rejects.toThrow("Cyclic helper imports are not supported");
});

it("rejects helpers importing the script context at runtime", async () => {
  const { modules } = serve({
    "scene.glts": `import "./a.ts";`,
    "a.ts": `import { scene } from "@drawcall/glts"; export const root = scene;`,
  });
  await expect(modules.prepareScript(`${base}scene.glts`))
    .rejects.toThrow("Helpers cannot import @drawcall/glts at runtime");
});

it("tracks a helper that fails, so fixing it reloads the script", async () => {
  const { modules } = serve({ "scene.glts": `import "./missing.ts";` });
  await expect(modules.prepareScript(`${base}scene.glts`)).rejects.toThrow("404");
  expect(modules.dependents(`${base}missing.ts`)).toEqual([`${base}scene.glts`]);
});
