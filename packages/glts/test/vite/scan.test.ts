import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "vite";
import { afterAll, expect, it } from "vitest";

import { scan } from "../../src/vite/scan.js";
import { writeFiles } from "./fixture.js";

const temp = normalizePath(await mkdtemp(join(tmpdir(), "glts-scan-")));
afterAll(() => rm(temp, { recursive: true }));

it("collects the package imports scripts do not get from the loader", async () => {
  await writeFiles(temp, {
    "imports/scene.glts": `
      import * as THREE from "three";
      import { scene } from "@drawcall/glts";
      import { Options } from "elided";
      import "side-effect";
      const options: Options | undefined = undefined;
      import noise from "simplex-noise@4";
      import remote from "https://cdn.test/remote.js";
      console.log(THREE, scene, noise, remote, options);
    `,
  });
  const { specifiers } = await scan(`${temp}/imports`);
  expect(specifiers).toEqual(["side-effect", "simplex-noise@4"]);
});

it("scans scripts in subdirectories once each", async () => {
  await writeFiles(temp, { "public/a.glts": `import "a"`, "public/nested/b.glts": `import "b"; import "a"` });
  expect(await scan(`${temp}/public`)).toEqual({
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
  expect(await scan(`${temp}/helpers`)).toEqual({
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

it("rejects local imports the loader would reject, which the type check resolves", async () => {
  await writeFiles(temp, { "extension/scene.glts": `import { tube } from "./geometry.js"; tube()`, "extension/geometry.ts": `` });
  await expect(scan(`${temp}/extension`)).rejects.toThrow("Unsupported local import: ./geometry.js");
});

it("rejects helpers outside the public directory, which the app does not serve as source", async () => {
  await writeFiles(temp, { "outside/public/scene.glts": `import "../util.ts"`, "outside/util.ts": `` });
  await expect(scan(`${temp}/outside/public`)).rejects.toThrow("Helpers must be in the public directory: ../util.ts");
});

it("rejects a script that does not parse, naming it", async () => {
  await writeFiles(temp, { "broken/scene.glts": "import {" });
  await expect(scan(`${temp}/broken`)).rejects.toThrow(`${temp}/broken/scene.glts`);
});
