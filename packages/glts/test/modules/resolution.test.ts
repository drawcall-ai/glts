import { expect, it } from "vitest";
import { helperURL, resolveModuleURL } from "../../src/modules/resolution.js";

const options = { cdnURL: new URL("https://cdn.test/"), threeRevision: "185", external: ["three", "simplex-noise"] };
const importer = "https://assets.test/path/asset.glts";

it("bundles packages and pins both Three addon spellings to the host revision", () => {
  const addon = resolveModuleURL("three/addons/controls/OrbitControls.js", importer, [], options, "script");
  const example = resolveModuleURL("three/examples/jsm/controls/OrbitControls.js", importer, [], options, "module");
  expect(addon.url.href).toBe(example.url.href);
  expect(addon.url.pathname).toBe("/three@0.185.0/examples/jsm/controls/OrbitControls.js");
  expect(addon.url.searchParams.get("external")).toBe("three,simplex-noise");
  expect(addon.transform).toBe(true);
});

it("permits relative dependencies in external modules but rejects them in scripts", () => {
  expect(resolveModuleURL("./dependency.js", importer, [], options, "module")).toEqual({
    url: new URL("https://assets.test/path/dependency.js"), transform: true,
  });
  expect(() => resolveModuleURL("./dependency.js", importer, [], options, "script"))
    .toThrow("Unsupported local import: ./dependency.js; import helpers as ./*.ts files");
  expect(() => resolveModuleURL("./child.glts?v=2", importer, [], options, "script"))
    .toThrow("use gltsLoader.loadAsync()");
});

it("passes external non-JavaScript URLs through while preparing absolute script imports", () => {
  const url = "https://assets.test/library.wasm";
  expect(resolveModuleURL(url, importer, [], options, "module").transform).toBe(false);
  expect(resolveModuleURL(url, importer, [], options, "script").transform).toBe(true);
});

it("treats relative .ts imports as helpers", () => {
  expect(helperURL("../shared/geometry.ts?v=2", importer)?.href).toBe("https://assets.test/shared/geometry.ts?v=2");
  expect(helperURL("./data.json", importer)).toBeUndefined();
  expect(helperURL("/root.ts", importer)).toBeUndefined();
  expect(helperURL("https://assets.test/remote.ts", importer)).toBeUndefined();
});
