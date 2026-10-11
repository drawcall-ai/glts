import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { GLTSError } from "../../src/errors.js";
import { isolateScriptBody, validateScript } from "../../src/modules/compiler.js";

const context = {
  importChain: ["https://example.test/tree.glts"],
  url: "https://example.test/tree.glts"
};

describe("validateScript", () => {
  it("accepts exportless scripts with contextual imports", () => {
    expect(() => validateScript(`
      import * as THREE from "three"
      import { scene, isPreview, onDispose } from "@drawcall/glts"
      if (isPreview) scene.add(new THREE.Group())
      onDispose(() => undefined)
    `, context)).not.toThrow();
  });

  it("rejects exports", () => {
    expect(() => validateScript("export const value = 1", context))
      .toThrow("GLTS scripts must not export values");
  });

  it("rejects GLTSLoader in favor of the contextual instance", () => {
    const validate = (): void => validateScript(
      'import { GLTSLoader } from "@drawcall/glts"',
      context
    );
    expect(validate).toThrow(GLTSError);
    expect(validate).toThrow("import gltsLoader instead");
  });

  it("rejects static GLTS imports", () => {
    expect(() => validateScript('import Child from "./child.glts"', context))
      .toThrow("use gltsLoader.loadAsync()");
  });
});

describe("isolateScriptBody", () => {
  const lineOf = (source: string, text: string): number =>
    source.slice(0, source.indexOf(text)).split("\n").length;
  const parseModule = (source: string): void => {
    parse(source, { sourceType: "module" });
  };

  it("runs the body in an async function after leading imports", () => {
    const source = [
      "// header",
      'import * as THREE from "three";',
      'import { onFrame, scene } from "@drawcall/glts";',
      "const state = new THREE.Group();",
      "onFrame(() => scene.add(state));"
    ].join("\n");
    const isolated = isolateScriptBody(source);

    expect(isolated).toContain('from "@drawcall/glts";await (async () => {');
    expect(isolated.endsWith("\n})();")).toBe(true);
    expect(lineOf(isolated, "const state")).toBe(lineOf(source, "const state"));
    expect(lineOf(isolated, "onFrame(()")).toBe(lineOf(source, "onFrame(()"));
    expect(() => parseModule(isolated)).not.toThrow();
  });

  it("hoists imports that follow body code", () => {
    const isolated = isolateScriptBody([
      'import * as THREE from "three"',
      "const size = 2",
      'import { scene } from "@drawcall/glts"',
      "scene.add(new THREE.Group())"
    ].join("\n"));

    expect(isolated.indexOf('from "@drawcall/glts"'))
      .toBeLessThan(isolated.indexOf("await (async () => {"));
    expect(isolated.indexOf("await (async () => {"))
      .toBeLessThan(isolated.indexOf("const size"));
    expect(() => parseModule(isolated)).not.toThrow();
  });

  it("keeps a leading hashbang first", () => {
    const isolated = isolateScriptBody('#!/usr/bin/env glts\nimport { scene } from "@drawcall/glts"\nscene.name = "x"');

    expect(isolated.startsWith("#!/usr/bin/env glts\nimport { scene }")).toBe(true);
    expect(() => parseModule(isolated)).not.toThrow();
  });
});
