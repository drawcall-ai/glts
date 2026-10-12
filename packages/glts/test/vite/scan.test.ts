import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "vite";
import { afterAll, expect, it } from "vitest";

import { scan } from "../../src/vite/scan.js";
import { writeFiles } from "./fixture.js";

const temp = normalizePath(await mkdtemp(join(tmpdir(), "glts-scan-")));
afterAll(() => rm(temp, { recursive: true }));

it("collects the runtime package imports scripts do not get from the loader", async () => {
  await writeFiles(temp, {
    "imports/scene.glts": `
      import * as THREE from "three";
      import { scene } from "@drawcall/glts";
      import type { Options } from "typed";
      import { type Other } from "kept-for-side-effects";
      import noise from "simplex-noise@4";
      import "./local.js";
      import remote from "https://cdn.test/remote.js";
      const lazy = await import("dynamic");
    `,
  });
  const { specifiers } = await scan(`${temp}/imports`);
  expect(specifiers).toEqual(["kept-for-side-effects", "simplex-noise@4"]);
});

it("scans nested scripts once per import", async () => {
  await writeFiles(temp, { "public/a.glts": `import "a"`, "public/nested/b.glts": `import "b"; import "a"` });
  expect(await scan(`${temp}/public`)).toEqual({
    scripts: [`${temp}/public/a.glts`, `${temp}/public/nested/b.glts`],
    specifiers: ["a", "b"],
  });
});

it("rejects a script that does not parse, naming it", async () => {
  await writeFiles(temp, { "broken/scene.glts": "import {" });
  await expect(scan(`${temp}/broken`)).rejects.toThrow(`${temp}/broken/scene.glts`);
});
