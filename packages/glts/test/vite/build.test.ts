import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { compilePlugin, get, symlinkThree, writeFiles } from "./fixture.js";

const cdnFiles: Readonly<Record<string, string>> = {
  "/y": `export * from "/y@1.0.0/es2022/y.mjs";`,
  "/y@1.0.0/es2022/y.mjs": [
    `export { marker } from "x";`,
    `export { token } from "z";`,
    `export { w } from "w";`,
    `export { y } from "./util.mjs";`,
  ].join("\n"),
  "/y@1.0.0/es2022/util.mjs": `export const y = "code-of-y";`,
  "/z": `export const token = {};`,
  "/buffer": `export const Buffer = "cdn-buffer";`,
  "/w@2": `export const w = "w@2";`,
  "/w": `export const w = "w";`,
};
const requests: URL[] = [];
const cdn = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://cdn.test");
  requests.push(url);
  const code = cdnFiles[url.pathname];
  response.writeHead(code === undefined ? 404 : 200, { "content-type": "text/javascript" });
  response.end(code);
});
/** The packages the CDN bundle at `path` was asked to import instead of inlining. */
const external = (path: string): string[] | undefined =>
  requests.find((url) => url.pathname === path)?.searchParams.get("external")?.split(",");
const temp = await mkdtemp(join(tmpdir(), "glts-build-"));
let built: unknown;

beforeAll(async () => {
  const { glts } = await compilePlugin(join(temp, "runtime"));
  await new Promise<void>((resolve) => cdn.listen(0, "127.0.0.1", resolve));
  const address = cdn.address();
  if (typeof address !== "object" || address === null) throw new Error("CDN server has no port");

  // The Vite root has no package.json of its own; the app's is one level up.
  await writeFiles(temp, {
    "package.json": JSON.stringify({ type: "module", dependencies: { x: "1.0.0" } }),
    "node_modules/x/package.json": JSON.stringify({ name: "x", type: "module", main: "index.js" }),
    "node_modules/x/index.js": `export const marker = {};`,
    "node_modules/x/index.d.ts": `export declare const marker: object;`,
    "web/public/scene.glts": [
      `import { marker } from "x";`,
      `import { y } from "y";`,
      `import { token } from "z";`,
      `import { Buffer } from "buffer";`,
      `import { w } from "w@2";`,
      `import * as THREE from "three";`,
      `if (!marker || !y || !token || !Buffer || !w || !THREE) throw new Error("Missing imports");`,
    ].join("\n"),
    "web/main.js": `export { default } from "virtual:glts-modules";`,
  });
  await symlinkThree(temp);
  await build({
    configFile: false,
    logLevel: "silent",
    root: join(temp, "web"),
    plugins: [glts({ cdnURL: `http://127.0.0.1:${address.port}/` })],
    build: { lib: { entry: "main.js", formats: ["es"], fileName: "main" }, minify: false },
  });
  built = await import(pathToFileURL(join(temp, "web/dist/main.js")).href);
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => cdn.close(resolve));
  await rm(temp, { recursive: true });
});

it("bundles each script import once, from the app or the CDN, pinned versions as written", () => {
  expect(JSON.parse(JSON.stringify(get(built, "default")))).toEqual({
    buffer: { Buffer: "cdn-buffer" },
    "w@2": { w: "w@2" },
    x: { marker: {} },
    y: { marker: {}, token: {}, w: "w", y: "code-of-y" },
    z: { token: {} },
  });
});

it("shares the app's dependencies with CDN packages", () => {
  expect(get(built, "default", "y", "marker")).toBe(get(built, "default", "x", "marker"));
});

it("shares CDN packages with each other, by package name", () => {
  expect(get(built, "default", "y", "token")).toBe(get(built, "default", "z", "token"));
  // The test CDN never inlines, so only the request shows y shares w, which scripts only import pinned.
  expect(external("/y")).toContain("w");
});

it("bundles each CDN package whole, never external to itself", () => {
  expect(external("/z")).not.toContain("z");
});
