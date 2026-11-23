import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { precompiledPrefix } from "../../src/linker/precompiled.js";
import { compilePlugin, get, symlinkThree, writeFiles } from "./fixture.js";

const cdnFiles: Readonly<Record<string, string>> = {
  "/y": `export * from "/y@1.0.0/es2022/y.mjs";`,
  "/y@1.0.0/es2022/y.mjs": [
    `export { marker } from "x";`,
    `export { token } from "z";`,
    `export { w } from "w";`,
    `export { y } from "./util.mjs";`,
    // A peer the CDN left unbundled, which both the loader and the bundle import by name.
    `import "/p@^1.0.0?external=x";`,
  ].join("\n"),
  "/y@1.0.0/es2022/util.mjs": `const { y } = await import("./init.mjs"); export { y };`,
  "/y@1.0.0/es2022/init.mjs": `export const y = "code-of-y";`,
  "/z": `export const token = {};`,
  "/p": `export {};`,
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
/** The CDN URLs of the modules the bundle contains. */
let bundled: string[] = [];

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
      `#!/usr/bin/env glts`,
      `import { marker } from "x";`,
      `import { y } from "y";`,
      `import { token } from "z";`,
      `import { Buffer } from "buffer";`,
      `import { w } from "w@2";`,
      `import * as THREE from "three";`,
      `import { value } from "./helper.ts";`,
      `if (value !== 1) throw new Error("Missing helper");`,
      `if (!marker || !y || !token || !Buffer || !w || !THREE) throw new Error("Missing imports");`,
    ].join("\n"),
    "web/public/helper.ts": `export const value: number = 1;`,
    "web/public/dynamic.ts": `export const value: number = 2;`,
    "web/main.js": `export { default, moduleSources } from "virtual:glts-modules";`,
  });
  await symlinkThree(temp);
  await build({
    configFile: false,
    logLevel: "silent",
    root: join(temp, "web"),
    plugins: [glts({ cdnURL: `http://127.0.0.1:${address.port}/` }), {
      name: "bundled-cdn-modules",
      buildEnd() {
        bundled = [...this.getModuleIds()].flatMap((id) => id.startsWith("\0glts:cdn:") ? [id.slice("\0glts:cdn:".length)] : []);
      },
    }],
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

it("emits precompiled scripts and helpers at their public paths without changing their sources", async () => {
  const script = await readFile(join(temp, "web/dist/scene.glts"), "utf8");
  expect(script.startsWith(precompiledPrefix)).toBe(true);
  expect(script).toContain("export default");
  for (const [name, value] of [["helper", 1], ["dynamic", 2]]) {
    expect(await readFile(join(temp, `web/dist/${name}.ts`), "utf8"))
      .toBe(precompiledPrefix + `export const value = ${value};`);
    expect(await readFile(join(temp, `web/public/${name}.ts`), "utf8"))
      .toBe(`export const value: number = ${value};`);
  }
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

it("preserves CDN namespace provenance instead of claiming a local package installation", () => {
  expect(get(built, "moduleSources", "x")).toBeUndefined();
  expect(get(built, "moduleSources", "y", "packages")).toEqual(["x"]);
  const dynamic = get(built, "moduleSources", "y", "moduleHashes");
  if (typeof dynamic !== "object" || dynamic === null) throw new Error("Missing remote provenance");
  expect(Object.keys(dynamic).map((url) => new URL(url).pathname)).toContain("/y@1.0.0/es2022/init.mjs");
  const modules = get(built, "moduleSources", "w@2", "moduleHashes");
  if (typeof modules !== "object" || modules === null) throw new Error("Missing remote provenance");
  expect(Object.keys(modules).map((url) => new URL(url).pathname)).toEqual(["/w@2"]);
  expect(Object.values(modules)).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
});

it("hashes exactly the CDN modules the bundle contains", () => {
  const sources = get(built, "moduleSources");
  if (typeof sources !== "object" || sources === null) throw new Error("Missing moduleSources");
  const hashed = new Set(Object.keys(sources).flatMap((name) => {
    const hashes = get(sources, name, "moduleHashes");
    if (typeof hashes !== "object" || hashes === null) throw new Error(`Missing ${name} module hashes`);
    return Object.keys(hashes);
  }));
  expect([...hashed].sort()).toEqual(bundled.sort());
  expect(bundled.map((url) => new URL(url).pathname)).toContain("/p");
});
