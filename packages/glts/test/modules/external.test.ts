import { REVISION } from "three";
import { expect, it } from "vitest";

import { ExternalModules } from "../../src/modules/external.js";
import { ModuleBridge } from "../../src/modules/bridge.js";

it("rejects a cycle between sibling dependencies instead of waiting on both", async () => {
  const bridge = new ModuleBridge();
  const sources = new Map([
    ["a", 'import "b"; import "c";'],
    ["b", 'import "c";'],
    ["c", 'import "b";'],
  ]);
  const external = new ExternalModules({
    bridge,
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
  const bridge = new ModuleBridge();
  const requests: string[] = [];
  const external = new ExternalModules({
    bridge,
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
  const noise = { createNoise2D: () => 0 };
  const bridge = new ModuleBridge({ "simplex-noise": noise });
  const requests: string[] = [];
  const external = new ExternalModules({
    bridge,
    cdnURL: new URL("https://cdn.test/"),
    fetch: async (input) => {
      requests.push(new URL(String(input)).pathname);
      return new Response("export {};");
    },
  });
  try {
    const host = await external.prepareImport("simplex-noise", "https://cdn.test/entry.glts", []);
    expect(host).toBe(bridge.getHostModuleURL("simplex-noise"));
    expect(bridge.getModuleExport("simplex-noise", "createNoise2D")).toBe(noise.createNoise2D);
    await external.prepareImport("simplex-noise@4", "https://cdn.test/entry.glts", []);
    expect(requests).toEqual(["/simplex-noise@4"]);
  } finally {
    bridge.dispose();
  }
});

it("pins both Three addon spellings to the host's revision and transforms every http(s) module", async () => {
  const bridge = new ModuleBridge({ "simplex-noise": {} });
  const requests: URL[] = [];
  const external = new ExternalModules({
    bridge,
    cdnURL: new URL("https://cdn.test/"),
    fetch: async (input) => {
      requests.push(new URL(String(input)));
      return new Response("export {};");
    },
  });
  try {
    const entry = "https://cdn.test/entry.js";
    await external.prepareImport("three/addons/controls/OrbitControls.js", entry, []);
    await external.prepareImport("three/examples/jsm/controls/OrbitControls.js", entry, []);
    await external.prepareImport("https://cdn.test/library@1.2.3", entry, []);
    expect(await external.prepareImport("data:text/javascript,", entry, [])).toBe("data:text/javascript,");
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      `/three@0.${REVISION}.0/examples/jsm/controls/OrbitControls.js`,
      "/library@1.2.3",
    ]);
    expect(requests[0]?.searchParams.get("external")).toBe("simplex-noise,three");
    await expect(external.prepareImport("#internal", entry, [])).rejects.toThrow("Unsupported CDN package import");
  } finally {
    bridge.dispose();
  }
});
