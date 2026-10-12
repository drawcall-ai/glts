import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { GLTSError } from "../../src/errors.js";
import { compileScript } from "../../src/modules/compiler.js";

const url = "https://example.test/tree.glts";

describe("script exports", () => {
  it.each([
    "export const value = 1",
    "export default 1",
    'export * from "three"',
    "type T = 1; const value = 1; export { type T, value }"
  ])("rejects value exports: %s", (source) => {
    expect(() => compileScript(source, url))
      .toThrow("GLTS scripts must not export values");
  });

  it.each([
    "export type State = number",
    "export interface State { elapsed: number }",
    "type T = 1; export type { T }",
    "type T = 1; export { type T }"
  ])("accepts type-only exports: %s", (source) => {
    expect(() => compileScript(source, url)).not.toThrow();
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
    const isolated = compileScript(source, url);

    expect(isolated).toContain("await (async () => {");
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
    ].join("\n"), url);

    expect(isolated.indexOf('from "@drawcall/glts"'))
      .toBeLessThan(isolated.indexOf("await (async () => {"));
    expect(isolated.indexOf("await (async () => {"))
      .toBeLessThan(isolated.indexOf("const size"));
    expect(() => parseModule(isolated)).not.toThrow();
  });

  it("accepts a leading hashbang", () => {
    const isolated = compileScript('#!/usr/bin/env glts\nimport { scene } from "@drawcall/glts"\nscene.name = "x"', url);

    expect(() => parseModule(isolated)).not.toThrow();
  });

  it("strips types and isolates the state they annotate", async () => {
    const compiled = compileScript([
      'import type { Group } from "three";',
      "interface State { elapsed: number }",
      "const state: State = { elapsed: 0 };",
      "await Promise.resolve();",
      'if (state.elapsed !== 0) throw new Error("Unexpected state");'
    ].join("\n"), url);
    expect(parse(compiled, { sourceType: "module" }).program.body.map((node) => node.type))
      .not.toContain("VariableDeclaration");
    await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`);
  });

  it("preserves directives, comments, and module semantics", async () => {
    const compiled = compileScript([
      '"use strict";',
      '// import "fake-module"; await (async () => {',
      'const text = `import "also-fake"; ${"/* not a comment */"}`;',
      'if (this !== undefined) throw new Error("Unexpected this");',
      'if (read() !== 42) throw new Error("Function did not hoist");',
      'function read() { return value; }',
      'import { value } from "data:text/javascript,export const value = 42";',
      'await Promise.resolve();',
      'if (!text.includes("/* not a comment */")) throw new Error("Changed literal");'
    ].join("\n"), url);
    const module = parse(compiled, { sourceType: "module" }).program;
    expect(module.directives).toHaveLength(0);
    expect(compiled).toContain('"use strict";');
    await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`);
  });

  it("rejects top-level return before wrapping the body", () => {
    expect(() => compileScript("return 42", url)).toThrow(GLTSError);
  });

  it("keeps a separator when hoisting a late import", async () => {
    const compiled = compileScript([
      "const values = []; values.push(1)",
      'import "data:text/javascript,";',
      "(function () { values.push(2); })()",
      'if (values.join() !== "1,2") throw new Error("Unexpected values");'
    ].join("\n"), url);
    await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`);
  });
});

it("drops imports used only as types, as TypeScript does", () => {
  const compiled = compileScript(`
    import { Options, merge } from "./geometry.ts"
    import { type Other } from "./other.ts"
    import "./side-effect.ts"
    const options: Options | Other = merge()
  `, url);
  expect(compiled).toContain('import { merge } from "./geometry.ts"');
  expect(compiled).not.toContain("./other.ts");
  expect(compiled).toContain('import "./side-effect.ts"');
});
