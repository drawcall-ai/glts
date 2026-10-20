import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, normalizePath } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { typecheck } from "../../src/vite/typecheck.js";
import { glts } from "../../src/vite/index.js";
import { symlinkThree, writeFiles } from "./fixture.js";

const local = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const temp = normalizePath(await mkdtemp(join(tmpdir(), "glts-typecheck-")));

beforeAll(async () => {
  await writeFiles(temp, {
    "app/package.json": JSON.stringify({ type: "module", dependencies: { x: "1.0.0" } }),
    // Types the context from source, so the test needs no build.
    "app/node_modules/@drawcall/glts/package.json": JSON.stringify({ name: "@drawcall/glts", types: local("src/index.ts") }),
    "app/node_modules/x/package.json": JSON.stringify({ name: "x", type: "module", types: "index.d.ts" }),
    "app/node_modules/x/index.d.ts": `export declare function size(object: object): number;`,
    "app/public/valid.glts": [
      `import * as THREE from "three";`,
      `import { instanceCount, isPreview, onDispose, scene } from "@drawcall/glts";`,
      `import { size } from "x";`,
      `import { y } from "y";`,
      `import confetti from "https://esm.sh/canvas-confetti";`,
      `if (isPreview === true && instanceCount > 1) confetti();`,
      `document.title = "valid";`,
      `const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());`,
      `scene.add(mesh);`,
      `const count: number = size(mesh) + y;`,
      `await Promise.resolve(count);`,
      `onDispose(() => mesh.geometry.dispose());`,
    ].join("\n"),
    "app/public/invalid.glts": [
      `import { scene } from "@drawcall/glts";`,
      `scene.add(42);`,
    ].join("\n"),
    "app/public/helped.glts": [
      `import { scene } from "@drawcall/glts";`,
      `import { name } from "./parts/name.ts";`,
      `import { missing } from "./parts/missing.ts";`,
      `scene.name = name;`,
    ].join("\n"),
    "app/public/parts/name.ts": `export const name: string = 42;`,
    "app/main.js": `export { default } from "virtual:glts-modules";`,
  });
  await symlinkThree(`${temp}/app`);
});

afterAll(() => rm(temp, { recursive: true }));

it("passes scripts using the context, the DOM, installed packages, CDN packages, and URL imports", async () => {
  await expect(typecheck([`${temp}/app/public/valid.glts`]))
    .resolves.toBeUndefined();
});

it("checks the helpers scripts import and reports missing ones", async () => {
  const errors = await typecheck([`${temp}/app/public/helped.glts`]);
  expect(errors).toMatch(/parts\/name\.ts:1:14 - error TS2322: Type 'number' is not assignable to type 'string'/);
  expect(errors).toMatch(/helped\.glts:3:25 - error TS2307: Cannot find module '\.\/parts\/missing\.ts'/);
});

it("fails the build with the type errors of public scripts", async () => {
  const built = build({
    configFile: false,
    logLevel: "silent",
    root: join(temp, "app"),
    plugins: [glts()],
    build: { lib: { entry: "main.js", formats: ["es"], fileName: "main" } },
  });
  await expect(built).rejects.toThrow(/invalid\.glts:2:11 - error TS2345: Argument of type 'number'/);
});
