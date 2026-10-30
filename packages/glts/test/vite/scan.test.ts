import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "vite";
import { afterAll, expect, it, vi } from "vitest";

import * as compiler from "../../src/linker/compile.js";
import { scan, type CompileCache } from "../../src/vite/scan.js";
import { writeFiles } from "./fixture.js";

const temp = normalizePath(await mkdtemp(join(tmpdir(), "glts-scan-")));
afterAll(() => rm(temp, { recursive: true }));

it("collects the package imports scripts do not get from the loader", async () => {
  await writeFiles(temp, {
    "imports/scene.glts": `
      import * as THREE from "three";
      import { MeshBasicNodeMaterial } from "three/webgpu";
      import { color } from "three/tsl";
      import { scene } from "@drawcall/glts";
      import { Options } from "elided";
      import "side-effect";
      const options: Options | undefined = undefined;
      import noise from "simplex-noise@4";
      import remote from "https://cdn.test/remote.js";
      console.log(THREE, MeshBasicNodeMaterial, color, scene, noise, remote, options);
    `,
  });
  const { specifiers } = await scan(`${temp}/imports`);
  expect(specifiers).toEqual(["side-effect", "simplex-noise@4"]);
});

it("scans scripts in subdirectories once each", async () => {
  await writeFiles(temp, { "public/a.glts": `import "a"`, "public/nested/b.glts": `import "b"; import "a"` });
  expect(await scan(`${temp}/public`)).toMatchObject({
    scripts: [`${temp}/public/a.glts`, `${temp}/public/nested/b.glts`],
    specifiers: ["a", "b"],
  });
});

it("follows helpers to the packages they import", async () => {
  await writeFiles(temp, {
    "helpers/scene.glts": `import "./parts/a.ts"; import "b"`,
    "helpers/parts/a.ts": `export * from "../shared.ts"; import "a"; import type { T } from "typed"`,
    "helpers/shared.ts": `import "./parts/a.ts"; import "./missing.ts"; export { s } from "shared"`,
  });
  expect(await scan(`${temp}/helpers`)).toMatchObject({
    scripts: [`${temp}/helpers/scene.glts`],
    specifiers: ["a", "b", "shared"],
  });
});

it("follows literal dynamic imports, but not computed ones", async () => {
  await writeFiles(temp, {
    "dynamic/scene.glts": 'import("./helper.ts"); import(`${"computed"}`); import("a" + "b")',
    "dynamic/helper.ts": `import("dynamic")`,
  });
  expect((await scan(`${temp}/dynamic`)).specifiers).toEqual(["dynamic"]);
});

it("retains compilation across scans and compiles helpers reached by computed imports", async () => {
  const directory = `${temp}/cached`;
  await writeFiles(directory, {
    "scene.glts": `const helper = "./helper.ts"; await import(helper);`,
    "helper.ts": `export const value: number = 1;`,
  });
  const script = vi.spyOn(compiler, "compileScript");
  const helper = vi.spyOn(compiler, "compileHelper");
  const cache: CompileCache = new Map();
  try {
    const first = await scan(directory, cache);
    expect(first.compiled.get(`${directory}/helper.ts`)).toContain("export const value = 1");
    await scan(directory, cache);
    expect(script).toHaveBeenCalledTimes(1);
    expect(helper).toHaveBeenCalledTimes(1);
    await writeFiles(directory, { "helper.ts": `export const value: number = 2;` });
    const edited = await scan(directory, cache);
    expect(edited.compiled.get(`${directory}/helper.ts`)).toContain("export const value = 2");
    expect(script).toHaveBeenCalledTimes(1);
    expect(helper).toHaveBeenCalledTimes(2);
  } finally {
    script.mockRestore();
    helper.mockRestore();
  }
});

it("records local imports the loader would reject, which the type check resolves, and still scans the rest", async () => {
  await writeFiles(temp, {
    "extension/scene.glts": `import "skipped"; import { tube } from "./geometry.js"; tube()`,
    "extension/geometry.ts": ``,
    "extension/valid.glts": `import "valid";`,
  });
  const { failures, compiled, specifiers } = await scan(`${temp}/extension`);
  expect([...failures.keys()]).toEqual([`${temp}/extension/scene.glts`]);
  expect(failures.get(`${temp}/extension/scene.glts`)).toMatchObject({ message: expect.stringContaining("Unsupported local import: ./geometry.js") });
  expect(compiled.has(`${temp}/extension/valid.glts`)).toBe(true);
  expect(specifiers).toEqual(["valid"]);
});

it("records helpers outside the public directory, which the app does not serve as source, under their importer", async () => {
  await writeFiles(temp, {
    "outside/public/scene.glts": `import "./parts/a.ts"`,
    "outside/public/parts/a.ts": `import "../../util.ts"`,
    "outside/util.ts": ``,
  });
  const { failures } = await scan(`${temp}/outside/public`);
  expect([...failures.keys()]).toEqual([`${temp}/outside/public/parts/a.ts`]);
  expect(failures.get(`${temp}/outside/public/parts/a.ts`)).toMatchObject({ message: expect.stringContaining("Helpers must be in the public directory: ../../util.ts") });
});

it("records a script that does not parse, naming it, and still compiles the rest", async () => {
  await writeFiles(temp, { "broken/scene.glts": "import {", "broken/valid.glts": `import "valid";` });
  const { failures, compiled, specifiers } = await scan(`${temp}/broken`);
  expect(failures.get(`${temp}/broken/scene.glts`)).toMatchObject({ message: expect.stringContaining(`${temp}/broken/scene.glts`) });
  expect([...compiled.keys()]).toEqual([`${temp}/broken/valid.glts`]);
  expect(specifiers).toEqual(["valid"]);
});
