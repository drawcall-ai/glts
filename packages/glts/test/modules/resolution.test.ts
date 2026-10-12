import { expect, it } from "vitest";
import { assertScriptImport, helperURL } from "../../src/modules/resolution.js";

const importer = "https://assets.test/path/asset.glts";

it("permits package and http(s) imports in scripts", () => {
  expect(() => assertScriptImport("simplex-noise@4", importer, [])).not.toThrow();
  expect(() => assertScriptImport("https://cdn.test/library.js", importer, [])).not.toThrow();
});

it("rejects package imports, GLTS imports, and local imports other than helpers", () => {
  expect(() => assertScriptImport("#internal", importer, [])).toThrow("Unsupported package import: #internal");
  expect(() => assertScriptImport("./dependency.js", importer, []))
    .toThrow("Unsupported local import: ./dependency.js; import helpers as ./*.ts files");
  expect(() => assertScriptImport("/root.ts", importer, [])).toThrow("Unsupported local import: /root.ts");
  expect(() => assertScriptImport("./child.glts?v=2", importer, [])).toThrow("use gltsLoader.loadAsync()");
});

it("treats relative .ts imports as helpers", () => {
  expect(helperURL("../shared/geometry.ts?v=2", importer)?.href).toBe("https://assets.test/shared/geometry.ts?v=2");
  expect(helperURL("./data.json", importer)).toBeUndefined();
  expect(helperURL("/root.ts", importer)).toBeUndefined();
  expect(helperURL("https://assets.test/remote.ts", importer)).toBeUndefined();
});
