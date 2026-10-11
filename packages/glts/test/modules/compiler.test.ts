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

describe("compileScript", () => {
  const lineOf = (source: string, text: string): number =>
    source.slice(0, source.indexOf(text)).split("\n").length;
  const parseModule = (source: string) => parse(source, { sourceType: "module" });
  const expectIsolated = (source: string): void => {
    const { program } = parseModule(source);
    expect(program.body.some((statement) => statement.type === "VariableDeclaration"))
      .toBe(false);
    expect(program.body.at(-1)).toMatchObject({
      type: "ExpressionStatement",
      expression: {
        type: "AwaitExpression",
        argument: {
          type: "CallExpression",
          callee: { type: "ArrowFunctionExpression", async: true }
        }
      }
    });
  };
  const execute = async (source: string): Promise<unknown> => {
    try {
      const url = `data:text/javascript,${encodeURIComponent(compileScript(source, context))}`;
      await import(/* @vite-ignore */ url);
      return Reflect.get(globalThis, "__compilerResult");
    } finally {
      Reflect.deleteProperty(globalThis, "__compilerResult");
    }
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

    expectIsolated(isolated);
    expect(lineOf(isolated, "const state")).toBe(lineOf(source, "const state"));
    expect(lineOf(isolated, "onFrame(()")).toBe(lineOf(source, "onFrame(()"));
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
    expectIsolated(isolated);
  });

  it("isolates a body after a hashbang and comments", () => {
    const isolated = compileScript('#!/usr/bin/env glts\n// header\nimport { scene } from "@drawcall/glts"\nconst state: number = 1;\nscene.name = String(state)', context);

    expectIsolated(isolated);
    expect(lineOf(isolated, "const state")).toBe(4);
  });

  it.each(["", "// comment only", "#!/usr/bin/env glts", 'import "three"; // trailing comment'])
    ("accepts a script without a body: %j", (source) => {
      expect(() => parseModule(compileScript(source, context))).not.toThrow();
    });

  it("preserves body lines with comments and empty statements between imports", () => {
    const source = '// header\n;\nimport "three";\n/* comment */;\nimport { scene } from "@drawcall/glts"; // trailing\n// before body\nconst state = 1;\nscene.name = String(state);';
    const compiled = compileScript(source, context);
    expectIsolated(compiled);
    expect(lineOf(compiled, "const state")).toBe(lineOf(source, "const state"));
    expect(lineOf(compiled, "scene.name")).toBe(lineOf(source, "scene.name"));
  });

  it("strips TypeScript after isolating the validated source", async () => {
    expect(await execute('interface State { elapsed: number }\nconst state: State = { elapsed: 0 };\nawait Promise.resolve();\nglobalThis.__compilerResult = state.elapsed + 1;'))
      .toBe(1);
  });

  it("hoists multiline and type-only imports after body code", () => {
    const compiled = compileScript('const state: number = 1;\nimport type { Group } from "three";\nimport {\n scene\n} from "@drawcall/glts";\nscene.name = String(state);', context);
    expectIsolated(compiled);
    expect(compiled).not.toContain("import type");
    expect(parseModule(compiled).program.body.find((statement) => statement.type === "ImportDeclaration")).toMatchObject({
      type: "ImportDeclaration", source: { value: "@drawcall/glts" }
    });
  });

  it("keeps a statement separator where a late import was removed", async () => {
    expect(await execute('globalThis.__compilerResult = 1\nimport "data:text/javascript,";\n(function () { globalThis.__compilerResult = 2; })()'))
      .toBe(2);
  });

  it("preserves strict mode and function hoisting without imports", async () => {
    expect(await execute('"use strict";\nglobalThis.__compilerResult = [this, advance()];\nfunction advance() { return 2; }'))
      .toEqual([undefined, 2]);
  });

  it.each(["return 1", "export const value = 1"])
    ("rejects invalid script syntax before wrapping: %s", (source) => {
      expect(() => compileScript(source, context)).toThrow(GLTSError);
    });

  it("keeps import.meta inside the isolated body", () => {
    const compiled = compileScript("const url = import.meta.url;", context);
    expectIsolated(compiled);
    expect(compiled).toContain("import.meta.url");
  });
});
