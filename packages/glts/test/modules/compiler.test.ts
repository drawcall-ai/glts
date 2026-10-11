import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { GLTSError } from "../../src/errors.js";
import { compileScript, validateScript } from "../../src/modules/compiler.js";

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
    const validate = () => validateScript(
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

describe("compileScript", () => {
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
    const isolated = compileScript(source, context);

    expect(isolated).toContain("await (async () => {");
    expect(isolated.endsWith("\n})();")).toBe(true);
    expect(lineOf(isolated, "const state")).toBe(lineOf(source, "const state"));
    expect(lineOf(isolated, "onFrame(()")).toBe(lineOf(source, "onFrame(()"));
    expect(() => parseModule(isolated)).not.toThrow();
  });

  it("hoists imports that follow body code", () => {
    const isolated = compileScript([
      'import * as THREE from "three"',
      "const size = 2",
      'import { scene } from "@drawcall/glts"',
      "scene.add(new THREE.Group())"
    ].join("\n"), context);

    expect(isolated.indexOf('from "@drawcall/glts"'))
      .toBeLessThan(isolated.indexOf("await (async () => {"));
    expect(isolated.indexOf("await (async () => {"))
      .toBeLessThan(isolated.indexOf("const size"));
    expect(() => parseModule(isolated)).not.toThrow();
  });

  it("accepts a leading hashbang", () => {
    const isolated = compileScript('#!/usr/bin/env glts\nimport { scene } from "@drawcall/glts"\nscene.name = "x"', context);

    expect(() => parseModule(isolated)).not.toThrow();
  });

  it("isolates TypeScript state before stripping types", async () => {
    const compiled = compileScript([
      'import type { Group } from "three";',
      "interface State { elapsed: number }",
      "const state: State = { elapsed: 0 };",
      "await Promise.resolve();",
      'if (state.elapsed !== 0) throw new Error("Unexpected state");'
    ].join("\n"), context);
    expect(parse(compiled, { sourceType: "module" }).program.body.map((node) => node.type))
      .not.toContain("VariableDeclaration");
    await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`);
  });

  it("keeps a separator when hoisting a late import", async () => {
    const compiled = compileScript([
      "const values = []; values.push(1)",
      'import "data:text/javascript,";',
      "(function () { values.push(2); })()",
      'if (values.join() !== "1,2") throw new Error("Unexpected values");'
    ].join("\n"), context);
    await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`);
  });
});
