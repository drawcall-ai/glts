import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer } from "vite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { compilePlugin, symlinkThree, writeFiles } from "./fixture.js";

const directory = await mkdtemp(join(tmpdir(), "glts-warmup-"));
let glts: typeof import("../../src/vite/index.js").glts;

beforeAll(async () => {
  ({ glts } = await compilePlugin(join(directory, "runtime")));
}, 30_000);

afterAll(() => rm(directory, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

async function app(name: string, scripts: Readonly<Record<string, string>>): Promise<string> {
  const root = join(directory, name);
  await writeFiles(root, {
    "package.json": JSON.stringify({ type: "module", dependencies: { probe: "1.0.0" } }),
    "index.html": `<script type="module" src="./main.js"></script>`,
    "main.js": `console.log("app");`,
    "node_modules/probe/package.json": JSON.stringify({ type: "module", exports: { import: "./index.js" } }),
    "node_modules/probe/index.js": `
      import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
      import { resolve } from "node:path";
      import { Mesh, BoxGeometry, MeshBasicMaterial } from "three";
      export function warm(name, source) {
        const cache = resolve("public/_cache");
        mkdirSync(cache, { recursive: true });
        const output = resolve(cache, name + ".json");
        if (!existsSync(output)) {
          appendFileSync(resolve("computed.txt"), name + "\\n");
          writeFileSync(output, JSON.stringify({ source: source.url }));
        }
        return new Mesh(new BoxGeometry(), new MeshBasicMaterial());
      }
      export function disposed(name) { appendFileSync(resolve("disposed.txt"), name + "\\n"); }
      export function environment(script, helper) {
        writeFileSync(resolve("env.json"), JSON.stringify({ script, helper, nodeEnv: process.env.NODE_ENV }));
      }
    `,
    ...scripts,
  });
  await symlinkThree(root);
  await mkdir(join(root, "node_modules/@drawcall"), { recursive: true });
  await symlink(join(directory, "runtime"), join(root, "node_modules/@drawcall/glts"), "dir");
  return root;
}

const compile = (root: string) => build({ configFile: false, logLevel: "silent", root, base: "/app/", plugins: [glts()] });

it("warms every public script during builds, reuses asset-owned caches and includes fresh cache files in output", async () => {
  const source = (name: string) => `
    import { Mesh } from "three";
    import { scene, onDispose } from "@drawcall/glts";
    import { warm, disposed } from "probe";
    const mesh = warm(${JSON.stringify(name)}, scene.source);
    if (!(mesh instanceof Mesh)) throw new Error("Multiple Three copies");
    scene.add(mesh);
    onDispose(() => { mesh.geometry.dispose(); mesh.material.dispose(); disposed(${JSON.stringify(name)}); });
  `;
  const root = await app("cache", {
    "public/parent.glts": source("parent") + `
      import { gltsLoader, loadingManager } from "@drawcall/glts";
      import { FileLoader } from "three";
      scene.add(await gltsLoader.loadAsync("/app/parts/child.glts"));
      const data = await new FileLoader(loadingManager).loadAsync("/app/data.txt");
      if (data !== "resource") throw new Error("Wrong public resource");
      if (await (await fetch("/app/data.txt")).text() !== data) throw new Error("Wrong root fetch");
      if (await (await fetch("./data.txt")).text() !== data) throw new Error("Wrong relative fetch");
      const canvas = document.createElement("canvas");
      if (!canvas.getContext("2d")) throw new Error("Missing canvas context");
    `,
    "public/parts/child.glts": source("child"),
    "public/unreferenced.glts": source("unreferenced"),
    "public/data.txt": "resource",
    "outside.glts": `throw new Error("Outside publicDir");`,
  });
  const server = await createServer({ configFile: false, logLevel: "silent", root, plugins: [glts()], server: { watch: null } });
  await server.close();
  await expect(readFile(join(root, "computed.txt"))).rejects.toMatchObject({ code: "ENOENT" });

  await compile(root);
  expect((await readFile(join(root, "computed.txt"), "utf8")).trim().split("\n").sort())
    .toEqual(["child", "parent", "unreferenced"]);
  expect((await readFile(join(root, "disposed.txt"), "utf8")).trim().split("\n").sort())
    .toEqual(["child", "parent", "unreferenced"]);
  for (const name of ["child", "parent", "unreferenced"]) {
    const cache = await readFile(join(root, `public/_cache/${name}.json`), "utf8");
    expect(await readFile(join(root, `dist/_cache/${name}.json`), "utf8")).toBe(cache);
    expect(cache).toContain("file:");
  }
  await compile(root);
  expect((await readFile(join(root, "computed.txt"), "utf8")).trim().split("\n")).toHaveLength(3);
  expect((await readFile(join(root, "disposed.txt"), "utf8")).trim().split("\n")).toHaveLength(6);
});

it.each([
  ["execution", `throw new Error("warmup execution failed");`],
  ["cleanup", `import { onDispose } from "@drawcall/glts"; onDispose(() => { throw new Error("warmup cleanup failed"); });`],
])("fails the build on %s errors with the underlying cause", async (kind, script) => {
  const root = await app(kind, { "public/broken.glts": script });
  await expect(compile(root)).rejects.toThrow(`warmup ${kind} failed`);
});

it.each([
  ["production", "production", true],
  ["staging", "production", true],
  ["development", "production", true],
  ["production", "development", false],
  ["staging", "test", false],
])("passes resolved Vite env for mode=%s and NODE_ENV=%s to scripts and helpers", async (mode, nodeEnv, production) => {
  vi.stubEnv("NODE_ENV", nodeEnv);
  const root = await app(`env-${mode}-${nodeEnv}`, {
    ".env": "VITE_LABEL=wrong-directory\n",
    "config/.env": "VITE_LABEL=base\nPUBLIC_LABEL=exposed\nPRIVATE_LABEL=secret\n",
    [`config/.env.${mode}`]: `VITE_LABEL=${mode}\n`,
    "public/env.glts": `
      import { environment } from "probe";
      import { env } from "./env.ts";
      const dev: boolean = import.meta.env.DEV;
      const mode: string = import.meta.env.MODE;
      environment({ ...import.meta.env, DEV: dev, MODE: mode }, env);
    `,
    "public/env.ts": `export const env = import.meta.env;`,
  });
  await build({
    configFile: false, logLevel: "silent", root, mode, base: "/assets/",
    envDir: "config", envPrefix: ["VITE_", "PUBLIC_"], plugins: [glts()],
  });
  const snapshot: unknown = JSON.parse(await readFile(join(root, "env.json"), "utf8"));
  const env = { MODE: mode, DEV: !production, PROD: production, SSR: true, BASE_URL: "/assets/", VITE_LABEL: mode, PUBLIC_LABEL: "exposed" };
  expect(snapshot).toEqual({ script: env, helper: env, nodeEnv });
});
