import { packages } from "@babel/standalone";
import { describe, expect, it } from "vitest";

import { GLTSError } from "../../src/errors.js";
import { compileHelper, compileScript } from "../../src/linker/compile.js";

const { parser: { parse } } = packages;
const url = "https://example.test/tree.glts";

async function execute(compiled: string, exports?: object): Promise<void> {
  const module: unknown = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`);
  if (typeof module !== "object" || module === null || !("default" in module) || typeof module.default !== "function") {
    throw new Error("Compiled script has no execution function");
  }
  await module.default(exports);
}

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
  const parseOutput = (source: string): void => {
    parse(source, { sourceType: "module" });
  };

  it("exports the isolated body after leading imports", () => {
    const source = [
      "// header",
      'import * as THREE from "three";',
      'import { onFrame, scene } from "@drawcall/glts";',
      "const state = new THREE.Group();",
      "onFrame(() => scene.add(state));"
    ].join("\n");
    const isolated = compileScript(source, url);

    expect(isolated).toContain("export default");
    expect(lineOf(isolated, "const state")).toBe(lineOf(source, "const state"));
    expect(lineOf(isolated, ".onFrame)")).toBe(lineOf(source, "onFrame(()"));
    expect(() => parseOutput(isolated)).not.toThrow();
  });

  it("hoists imports that follow body code", () => {
    const isolated = compileScript([
      'import { scene } from "@drawcall/glts"',
      "const size = 2",
      'import * as THREE from "three"',
      "scene.add(new THREE.Group())"
    ].join("\n"), url);

    expect(isolated.indexOf('from "three"'))
      .toBeLessThan(isolated.indexOf("export default"));
    expect(isolated.indexOf("export default"))
      .toBeLessThan(isolated.indexOf("const size"));
    expect(() => parseOutput(isolated)).not.toThrow();
  });

  it("drops a leading hashbang, so a prefix can come first", () => {
    const isolated = compileScript('#!/usr/bin/env glts\nimport { scene } from "@drawcall/glts"\nscene.name = "x"', url);

    expect(isolated).not.toContain("#!");
    expect(() => parseOutput(isolated)).not.toThrow();
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
    await execute(compiled);
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
    await execute(compiled);
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
    await execute(compiled);
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

it("preserves contextual aliases, namespace identity, shadowing, shorthand, and unbound calls", async () => {
  const callbacks: (() => void)[] = [];
  let scene = { name: "initial" };
  const exports = Object.freeze({
    get scene() { return scene; },
    onFrame: function (this: unknown, callback: () => void) {
      expect(this).toBeUndefined();
      callbacks.push(callback);
    },
  });
  await execute(compileScript(`
    import { scene as root, onFrame as frame } from "@drawcall/glts";
    import * as first from "@drawcall/glts";
    import * as second from "@drawcall/glts";
    const _imports = "collision";
    if (first !== second || first.scene !== root) throw new Error("Import identity changed");
    if (!Object.isFrozen(first)) throw new Error("Mutable namespace");
    const shorthand = { root };
    if (shorthand.root !== root) throw new Error("Shorthand changed");
    function shadow(root) { return { root }; }
    if (shadow("local").root !== "local") throw new Error("Shadow changed");
    const { scene: snapshot } = first;
    frame(() => {
      if (root !== first.scene || root.name !== "replacement") throw new Error("Stale scene");
      if (snapshot.name !== "initial") throw new Error("Destructuring became live");
    });
  `, url), exports);
  scene = { name: "replacement" };
  expect(callbacks).toHaveLength(1);
  callbacks[0]?.();
});

it.each([
  'import missing from "@drawcall/glts"; console.log(missing);',
  'import { unknown } from "@drawcall/glts"; console.log(unknown);',
])("rejects invalid contextual imports: %s", (source) => {
  expect(() => compileScript(source, url)).toThrow(GLTSError);
});

it.each([
  'import { scene } from "@drawcall/glts"; scene = {};',
  'import * as glts from "@drawcall/glts"; glts = {};',
  'import { value } from "library"; value = 1;',
  'import { value } from "library"; [value] = [1];',
])("rejects assignments to imports: %s", (source) => {
  const rejected = expect.objectContaining({
    phase: "transform", cause: expect.objectContaining({ message: expect.stringContaining("Cannot assign to import") }),
  });
  expect(() => compileScript(source, url)).toThrow(rejected);
  expect(() => compileHelper(source, url, [url])).toThrow(rejected);
});
