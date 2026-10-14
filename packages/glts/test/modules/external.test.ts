import { REVISION } from "three";
import { afterEach, expect, it } from "vitest";

import { ExternalModules } from "../../src/modules/external.js";
import { ModuleBridge } from "../../src/modules/bridge.js";
import type { Fetch } from "../../src/modules/fetch.js";
import type { GLTSModules, GLTSResolve } from "../../src/types.js";

let disposals: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposals) dispose();
  disposals = [];
});

/** External modules fetching with `fetch` and sharing the host `modules`. */
function externalModules(
  fetch: Fetch,
  modules: GLTSModules = {},
  resolve?: GLTSResolve,
): { bridge: ModuleBridge; external: ExternalModules } {
  const bridge = new ModuleBridge(modules);
  disposals.push(() => bridge.dispose());
  return { bridge, external: new ExternalModules({ bridge, cdnURL: new URL("https://cdn.test/"), fetch, resolve }) };
}

it("rejects a cycle between sibling dependencies instead of waiting on both", async () => {
  const sources = new Map([
    ["a", 'import "b"; import "c";'],
    ["b", 'import "c";'],
    ["c", 'import "b";'],
  ]);
  const { external } = externalModules(async (input) => {
    const source = sources.get(new URL(String(input)).pathname.slice(1));
    if (source === undefined) throw new Error(`Unexpected fetch: ${input}`);
    return new Response(source);
  });
  await expect(external.linkImport("a", "https://cdn.test/entry.glts", [])).rejects.toThrow(
    "Cyclic CDN modules are not supported",
  );
}, 1000);

it("links a bundle's peer import to the package the script imports, so both share one instance", async () => {
  const requests: string[] = [];
  const { bridge, external } = externalModules(async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.pathname === "/robotics") return new Response('import "/physics@^0.16.0?external=three&target=es2022";');
    return new Response("export {};");
  }, { physics: {} });
  await external.linkImport("robotics", "https://cdn.test/entry.glts", []);
  expect(requests).toEqual(["/robotics?bundle=&external=physics%2Cthree&target=es2022"]);
  expect(bridge.getHostModuleURL("physics")).toBeDefined();

  const { external: cdnOnly } = externalModules(async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.pathname === "/robotics") return new Response('import "/physics@^0.16.0?external=three";');
    return new Response("export {};");
  });
  requests.length = 0;
  await cdnOnly.linkImport("robotics", "https://cdn.test/entry.glts", []);
  await cdnOnly.linkImport("physics", "https://cdn.test/entry.glts", []);
  expect(requests).toEqual([
    "/robotics?bundle=&external=three&target=es2022",
    "/physics?bundle=&external=three&target=es2022",
  ]);
});

it("resolves a CDN module's dynamic imports when they run, so one that never runs is never fetched", async () => {
  const requests: string[] = [];
  const { external } = externalModules(async (input) => {
    const { pathname } = new URL(String(input));
    requests.push(pathname);
    if (pathname === "/robotics") {
      return new Response('export const ros = () => import("rclnodejs"); export const chunk = await import("./chunk.js");');
    }
    if (pathname === "/chunk.js") return new Response("export const value = 1;");
    throw new Error(`Unexpected fetch: ${input}`);
  });
  const url = await external.linkImport("robotics", "https://cdn.test/entry.glts", []);
  expect(requests).toEqual(["/robotics"]);
  expect(await import(url)).toMatchObject({ chunk: { value: 1 } });
  expect(requests).toEqual(["/robotics", "/chunk.js"]);
});

it("links only peers under the CDN's path, leaving other root paths of its origin as URLs", async () => {
  const requests: string[] = [];
  const bridge = new ModuleBridge({});
  disposals.push(() => bridge.dispose());
  const external = new ExternalModules({
    bridge,
    cdnURL: new URL("https://cdn.test/esm/"),
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      if (url.pathname === "/esm/robotics") return new Response('import "/esm/physics@^1.0.0"; import "/other@1.0.0";');
      return new Response("export {};");
    },
  });
  await external.linkImport("robotics", "https://cdn.test/entry.glts", []);
  expect(requests).toEqual([
    "/esm/robotics?bundle=&external=three&target=es2022",
    "/esm/physics?bundle=&external=three&target=es2022",
    "/other@1.0.0",
  ]);
});

it("stops at the first failing dependency without starting later imports", async () => {
  const requests: string[] = [];
  const { external } = externalModules(async (input) => {
    const name = new URL(String(input)).pathname.slice(1);
    requests.push(name);
    if (name === "root") {
      return new Response('import "helper"; import "missing"; import "late";');
    }
    if (name === "helper") return new Response("export const helper = 1;");
    if (name === "missing") return new Response("", { status: 404 });
    throw new Error(`Unexpected fetch: ${input}`);
  });

  await expect(external.linkImport("root", "https://cdn.test/entry.glts", [])).rejects.toThrow("404");
  expect(requests).toEqual(["root", "helper", "missing"]);
});

it("imports host modules by exact specifier and sends other versions to the CDN, even with a resolve", async () => {
  const noise = { createNoise2D: () => 0 };
  const requests: string[] = [];
  const { bridge, external } = externalModules(async (input) => {
    requests.push(new URL(String(input)).pathname);
    return new Response("export {};");
  }, { "simplex-noise": noise }, () => {
    throw new Error("Pinned versions never resolve through the host");
  });
  const host = await external.linkImport("simplex-noise", "https://cdn.test/entry.glts", []);
  expect(host).toBe(bridge.getHostModuleURL("simplex-noise"));
  expect(bridge.namespaces["simplex-noise"]).toBe(noise);
  await external.linkImport("simplex-noise@4", "https://cdn.test/entry.glts", []);
  expect(requests).toEqual(["/simplex-noise@4"]);
});

it("pins both Three addon spellings to the host's revision and transforms every http(s) module", async () => {
  const requests: URL[] = [];
  const { external } = externalModules(async (input) => {
    requests.push(new URL(String(input)));
    return new Response("export {};");
  }, { "simplex-noise": {} });
  const entry = "https://cdn.test/entry.js";
  await external.linkImport("three/addons/controls/OrbitControls.js", entry, []);
  await external.linkImport("three/examples/jsm/controls/OrbitControls.js", entry, []);
  await external.linkImport("https://cdn.test/library@1.2.3", entry, []);
  expect(await external.linkImport("data:text/javascript,", entry, [])).toBe("data:text/javascript,");
  expect(requests.map(({ pathname }) => pathname)).toEqual([
    `/three@0.${REVISION}.0/examples/jsm/controls/OrbitControls.js`,
    "/library@1.2.3",
  ]);
  expect(requests[0]?.searchParams.get("external")).toBe("simplex-noise,three");
  await expect(external.linkImport("#internal", entry, [])).rejects.toThrow("Unsupported CDN package import");
});
