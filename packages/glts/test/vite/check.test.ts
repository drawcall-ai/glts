import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, normalizePath } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { check } from "../../src/vite/check.js";
import { glts } from "../../src/vite/index.js";
import { linkThree, writeFiles } from "./fixture.js";

const local = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const temp = normalizePath(await mkdtemp(join(tmpdir(), "glts-check-")));

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
    "app/main.js": `export { default } from "virtual:glts-modules";`,
  });
  await linkThree(`${temp}/app`);
});

afterAll(() => rm(temp, { recursive: true }));

it("passes scripts using the context, the DOM, installed packages, CDN packages, and URL imports", async () => {
  await expect(check([`${temp}/app/public/valid.glts`]))
    .resolves.toBeUndefined();
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
