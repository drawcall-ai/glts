import * as THREE from "three";
import { afterEach, expect, it } from "vitest";

import { Linker } from "../../src/linker/index.js";
import type { GLTSModules, GLTSResolve } from "../../src/types.js";
import { createExecution } from "../execution/fixture.js";

const scene = "https://assets.test/scene.glts";
let linker: Linker | undefined;

afterEach(() => linker?.dispose());

interface Options {
  readonly cdnURL?: string;
  readonly modules?: GLTSModules;
  readonly resolve?: GLTSResolve;
  readonly linkDynamicImports?: boolean;
}

/** A linker of the scripts `fetch` serves, sharing `modules` and the host's `three` and `@drawcall/glts`. */
function createLinker(fetch: (input: RequestInfo | URL) => Promise<Response>, { cdnURL, modules, ...options }: Options = {}): Linker {
  linker = new Linker({
    ...options,
    cdnURL: new URL(cdnURL ?? "https://cdn.test/"),
    modules: { ...modules, three: THREE, "@drawcall/glts": {} },
    fetch,
  });
  return linker;
}

/** A linker serving `sources` by path from any origin, recording each request. */
function serveLinker(sources: Record<string, string>, options: Options = {}): { linker: Linker; requests: URL[]; paths: () => string[] } {
  const requests: URL[] = [];
  const linker = createLinker(async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const source = sources[url.pathname.slice(1)];
    return source === undefined ? new Response(null, { status: 404 }) : new Response(source);
  }, options);
  return { linker, requests, paths: () => requests.map(({ pathname }) => pathname.slice(1)) };
}

/** Links and runs the script. */
async function run(linker: Linker): Promise<void> {
  const script = await linker.getScript(scene);
  await createExecution({ url: script.executionURL, module: script.module }).run();
}

it("links a script's helpers once each and tracks the script as their importer", async () => {
  const { linker, paths } = serveLinker({
    "scene.glts": `import { a } from "./a.ts"; import { b } from "./b.ts"; import { b as again } from "./b.ts"; console.log(a, b, again);`,
    "a.ts": `import { shared } from "./shared.ts"; export const a: number = shared;`,
    "b.ts": `import { shared } from "./shared.ts"; import type { GLTSPhase } from "@drawcall/glts"; export const b: number | GLTSPhase = shared;`,
    "shared.ts": `export const shared = 1;`,
  });
  const script = await linker.getScript(scene);
  expect(paths().sort()).toEqual(["a.ts", "b.ts", "scene.glts", "shared.ts"]);
  expect(script.dependencies.urls()).toEqual(["a.ts", "b.ts", "scene.glts", "shared.ts"].map((path) => `https://assets.test/${path}`));
  expect(linker.invalidate("https://assets.test/shared.ts")).toEqual([scene]);
  expect(linker.invalidate("https://assets.test/other.ts")).toEqual(["https://assets.test/other.ts"]);
});

it("links query variants to one graph, fetched with the first request's query, each execution keeping its own", async () => {
  const requests: string[] = [];
  const redirected = "https://assets.test/redirected/";
  const linker = createLinker(async (input) => {
    requests.push(String(input));
    if (String(input) === `${redirected}helper.ts`) return new Response("export const value = 1;");
    const response = new Response(`import "./helper.ts";`);
    Object.defineProperty(response, "url", { value: `${redirected}scene.glts?token=cdn` });
    return response;
  });
  const queries = ["?signature=valid", "?variant=2", ""];
  const variants = await Promise.all(queries.map((query) => linker.getScript(scene + query)));
  expect(new Set(variants.map(({ module }) => module)).size).toBe(1);
  expect(variants.map(({ executionURL }) => executionURL)).toEqual(queries.map((query) => `${redirected}scene.glts${query}`));
  expect(requests).toEqual([`${scene}?signature=valid`, `${redirected}helper.ts`]);
  const all = queries.map((query) => scene + query);
  expect(linker.invalidate(`${redirected}helper.ts`)).toEqual(all);
  expect(linker.invalidate(`${redirected}scene.glts`)).toEqual(all);
});

it("rejects helper cycles and cycles between CDN packages, instead of waiting on them", async () => {
  const helpers = serveLinker({ "scene.glts": `import "./a.ts";`, "a.ts": `import "./b.ts";`, "b.ts": `import "./a.ts";` });
  await expect(helpers.linker.getScript(scene)).rejects.toThrow("Cyclic imports are not supported");
  helpers.linker.dispose();

  const cdn = serveLinker({ "scene.glts": `import "a";`, a: `import "b"; import "c";`, b: `import "c";`, c: `import "b";` });
  await expect(cdn.linker.getScript(scene)).rejects.toThrow("Cyclic imports are not supported");
}, 1000);

it.each(["helpers", "packages"])("rejects concurrent scripts whose %s wait on each other's linking", async (kind) => {
  const imports = kind === "helpers" ? ["./a.ts", "./b.ts"] : ["a", "b"];
  const [a, b] = imports;
  const { linker } = serveLinker({
    "scene.glts": `import ${JSON.stringify(a)};`,
    "other.glts": `import ${JSON.stringify(b)};`,
    [kind === "helpers" ? "a.ts" : "a"]: `import ${JSON.stringify(b)};`,
    [kind === "helpers" ? "b.ts" : "b"]: `import ${JSON.stringify(a)};`,
  });
  await expect(Promise.all([linker.getScript(scene), linker.getScript("https://assets.test/other.glts")]))
    .rejects.toThrow("Cyclic imports are not supported");
}, 1000);

it("shares an in-flight helper across independently linked scripts without treating the diamond as a cycle", async () => {
  const { linker, paths } = serveLinker({
    "scene.glts": `import "./a.ts";`,
    "other.glts": `import "./b.ts";`,
    "a.ts": `import "./shared.ts";`,
    "b.ts": `import "./shared.ts";`,
    "shared.ts": `export {};`,
  });
  await Promise.all([linker.getScript(scene), linker.getScript("https://assets.test/other.glts")]);
  expect(paths().sort()).toEqual(["a.ts", "b.ts", "other.glts", "scene.glts", "shared.ts"]);
});

it("rejects helpers importing @drawcall/glts at runtime", async () => {
  const { linker } = serveLinker({
    "scene.glts": `import "./a.ts";`,
    "a.ts": `import { scene } from "@drawcall/glts"; export const value = scene;`,
  });
  await expect(linker.getScript(scene)).rejects.toMatchObject({
    phase: "resolve",
    importChain: ["https://assets.test/scene.glts", "https://assets.test/a.ts"],
    message: expect.stringContaining("Helpers import only types from @drawcall/glts"),
  });
});

it("tracks a helper that fails, so fixing it reloads the script", async () => {
  const { linker } = serveLinker({ "scene.glts": `import "./missing.ts";` });
  await expect(linker.getScript(scene)).rejects.toThrow("404");
  expect(linker.invalidate("https://assets.test/missing.ts")).toEqual([scene]);
});

it("keeps fresh static dependencies separate from historical reload importers", async () => {
  const sources = { "scene.glts": `import "./old.ts";`, "old.ts": `export {};`, "new.ts": `export {};` };
  const { linker } = serveLinker(sources);
  const previous = await linker.getScript(scene);
  sources["scene.glts"] = `import "./new.ts";`;
  linker.invalidate(scene);
  const next = await linker.getScript(scene);
  expect(previous.dependencies.urls()).toEqual(["https://assets.test/old.ts", scene]);
  expect(next.dependencies.urls()).toEqual(["https://assets.test/new.ts", scene]);
  expect(linker.invalidate("https://assets.test/old.ts")).toEqual([scene]);
  expect(linker.invalidate("https://assets.test/new.ts")).toEqual([scene]);
});

it("records requested and redirected helper URLs while excluding package modules", async () => {
  const linker = createLinker(async (input) => {
    if (String(input) === scene) return new Response(`import "./helper.ts"; import "library";`);
    const response = new Response(`export const value = 1;`);
    Object.defineProperty(response, "url", { value: "https://assets.test/redirected/helper.ts" });
    return response;
  }, { modules: { library: { value: 1 } } });
  const script = await linker.getScript(scene);
  expect(script.dependencies.urls()).toEqual(["https://assets.test/helper.ts", "https://assets.test/redirected/helper.ts", scene]);
  expect(linker.invalidate("https://assets.test/redirected/helper.ts")).toEqual([scene]);
});

it("links dynamic imports when they run, so one that never runs is never fetched", async () => {
  const { linker, paths } = serveLinker({
    "scene.glts": `import "./helper.ts"; import { chunk } from "robotics"; if (chunk.value !== 1) throw new Error("No chunk");`,
    "helper.ts": `export async function load() { return import("./other.ts"); }`,
    robotics: `export const ros = () => import("rclnodejs"); export const chunk = await import("./chunk.js");`,
    "chunk.js": `export const value = 1;`,
  });
  const script = await linker.getScript(scene);
  expect(script.dependencies.urls()).toEqual(["https://assets.test/helper.ts", scene]);
  expect(paths()).toEqual(["scene.glts", "helper.ts", "robotics"]);
  await run(linker);
  expect(paths()).toEqual(["scene.glts", "helper.ts", "robotics", "chunk.js"]);
});

it("links a dynamic import that statically imports its importer back, as native modules do", async () => {
  const { linker } = serveLinker({
    "scene.glts": `import { load } from "./a.ts"; const { doubled } = await load(); if (doubled !== 2) throw new Error("No b");`,
    "a.ts": `export const value = 1; export const load = () => import("./b.ts");`,
    "b.ts": `import { value } from "./a.ts"; export const doubled = value * 2;`,
  });
  await run(linker);
}, 1000);

it("links a bundle's dynamic chunks after the bundle, so a chunk importing it back is no cycle", async () => {
  const lib = "https://cdn.test/lib?bundle=&external=%40drawcall%2Fglts%2Cthree&target=es2022";
  const { linker } = serveLinker({
    lib: `export const value = 1; export const load = () => import("./chunk.js");`,
    "chunk.js": `import { value } from ${JSON.stringify(lib)}; export const doubled = value * 2;`,
  }, { linkDynamicImports: true });
  const [module] = await linker.getModules(["lib"]);
  expect(Object.keys(module?.dependencies.moduleHashes() ?? {})).toEqual(["https://cdn.test/chunk.js", lib]);
}, 1000);

it("records a shared package's dynamic chunk for every bundle importing it", async () => {
  const { linker } = serveLinker({
    a: `import "p";`,
    b: `import "p";`,
    p: `export const load = () => import("./chunk.js");`,
    "chunk.js": `export const value = 1;`,
  }, { linkDynamicImports: true });
  const modules = await linker.getModules(["a", "b"]);
  expect(modules.map(({ dependencies }) => Object.keys(dependencies.moduleHashes()).includes("https://cdn.test/chunk.js")))
    .toEqual([true, true]);
}, 1000);

it("links a bundle's peer import to the package the script or host has, so both share one instance", async () => {
  const peer = `import "/physics@^0.16.0?external=three";`;
  const host = serveLinker({ "scene.glts": `import "robotics";`, robotics: peer }, { modules: { physics: {} } });
  await host.linker.getScript(scene);
  expect(host.paths()).toEqual(["scene.glts", "robotics"]);
  expect(host.requests[1]?.searchParams.get("external")).toBe("@drawcall/glts,physics,three");
  host.linker.dispose();

  const cdn = serveLinker({ "scene.glts": `import "robotics"; import "physics";`, robotics: peer, physics: "export {};" });
  await cdn.linker.getScript(scene);
  expect(cdn.requests.map(({ pathname, search }) => pathname + search)).toEqual([
    "/scene.glts",
    "/robotics?bundle=&external=%40drawcall%2Fglts%2Cthree&target=es2022",
    "/physics?bundle=&external=%40drawcall%2Fglts%2Cthree&target=es2022",
  ]);
});

it("bundles a package subpath without its own package in the external list", async () => {
  const { linker, requests } = serveLinker({ "scene.glts": `import "lodash/fp";`, "lodash/fp": "export {};" }, {
    modules: { lodash: {}, "https://assets.test/helper.ts": {} },
  });
  await linker.getScript(scene);
  expect(requests[1]?.searchParams.get("external")).toBe("@drawcall/glts,three");
});

it("links only peers under the CDN's path, leaving other root paths of its origin as URLs", async () => {
  const { linker, requests } = serveLinker({
    "scene.glts": `import "robotics";`,
    "esm/robotics": `import "/esm/physics@^1.0.0"; import "/other@1.0.0";`,
    "esm/physics": "export {};",
    "other@1.0.0": "export {};",
  }, { cdnURL: "https://cdn.test/esm/" });
  await linker.getScript(scene);
  expect(requests.map(({ pathname, search }) => pathname + search)).toEqual([
    "/scene.glts",
    "/esm/robotics?bundle=&external=%40drawcall%2Fglts%2Cthree&target=es2022",
    "/esm/physics?bundle=&external=%40drawcall%2Fglts%2Cthree&target=es2022",
    "/other@1.0.0",
  ]);
});

it("stops at the first failing dependency without starting later imports", async () => {
  const { linker, paths } = serveLinker({
    "scene.glts": `import "root";`,
    root: `import "helper"; import "missing"; import "late";`,
    helper: "export {};",
  });
  await expect(linker.getScript(scene)).rejects.toThrow("404");
  expect(paths()).toEqual(["scene.glts", "root", "helper", "missing"]);
});

it("imports host modules by exact specifier and sends other versions to the CDN, even with a resolve", async () => {
  const { linker, paths } = serveLinker({
    "scene.glts": `import { createNoise2D } from "simplex-noise"; import "simplex-noise@4"; if (createNoise2D() !== 0) throw new Error("Not the host's");`,
    "simplex-noise@4": "export {};",
  }, {
    modules: { "simplex-noise": { createNoise2D: () => 0 } },
    resolve: () => { throw new Error("Pinned versions never resolve through the host"); },
  });
  await run(linker);
  expect(paths()).toEqual(["scene.glts", "simplex-noise@4"]);
});

it("pins both Three addon spellings to the host's revision and links every http(s) module", async () => {
  const addon = `three@0.${THREE.REVISION}.0/examples/jsm/controls/OrbitControls.js`;
  const { linker, paths } = serveLinker({
    "scene.glts": `
      import "three/addons/controls/OrbitControls.js";
      import "three/examples/jsm/controls/OrbitControls.js";
      import { value } from "https://cdn.test/library@1.2.3";
      if (value !== 1) throw new Error("Not linked");
    `,
    [addon]: "export {};",
    "library@1.2.3": `export { value } from "data:text/javascript,export const value = 1;";`,
  });
  await run(linker);
  expect(paths()).toEqual(["scene.glts", addon, "library@1.2.3"]);
});

it("rejects a CDN package's subpath import", async () => {
  const { linker } = serveLinker({ "scene.glts": `import "library";`, library: `import "#internal";` });
  await expect(linker.getScript(scene)).rejects.toThrow("Unsupported subpath import: #internal");
});
