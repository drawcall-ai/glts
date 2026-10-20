import { expect, it } from "vitest";
import { classifyImport } from "../../src/linker/resolution.js";

const importer = "https://assets.test/path/asset.glts";

it("classifies the runtime, @drawcall/glts, packages, and http(s) imports", () => {
  expect(classifyImport("glts:runtime", importer, [])).toEqual({ kind: "runtime" });
  expect(classifyImport("@drawcall/glts", importer, [])).toEqual({ kind: "glts" });
  expect(classifyImport("simplex-noise@4", importer, [])).toEqual({ kind: "package" });
  expect(classifyImport("https://cdn.test/library.js", importer, [])).toEqual({ kind: "package" });
});

it("rejects GLTS imports and local imports other than helpers", () => {
  expect(() => classifyImport("./dependency.js", importer, []))
    .toThrow("Unsupported local import: ./dependency.js; import helpers as ./*.ts files");
  expect(() => classifyImport("/root.ts", importer, [])).toThrow("Unsupported local import: /root.ts");
  expect(() => classifyImport("./child.glts?v=2", importer, [])).toThrow("use gltsLoader.loadAsync()");
  expect(() => classifyImport("https://assets.test/remote.ts", importer, [])).not.toThrow();
});

it("treats relative .ts imports as helpers", () => {
  expect(classifyImport("../shared/geometry.ts?v=2#part", importer, []))
    .toEqual({ kind: "helper", url: "https://assets.test/shared/geometry.ts?v=2" });
});
