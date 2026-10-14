import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "vite";

const exec = promisify(execFile);
const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "glts-cli-"));
const project = join(directory, "project");
const cli = join(directory, "dist/cli/index.js");

beforeAll(async () => {
  await mkdir(project);
  await symlink(join(packageDir, "node_modules"), join(directory, "node_modules"), "dir");
  await copyFile(join(packageDir, "package.json"), join(directory, "package.json"));
  await exec(process.execPath, [join(packageDir, "node_modules/typescript/bin/tsc"), "-p", join(packageDir, "tsconfig.json"), "--outDir", join(directory, "dist"), "--declaration", "false", "--declarationMap", "false"]);
  await mkdir(join(project, "node_modules/@drawcall"), { recursive: true });
  await mkdir(join(project, "node_modules/.bin"));
  await symlink(directory, join(project, "node_modules/@drawcall/glts"), "dir");
  await chmod(cli, 0o755);
  await symlink(cli, join(project, "node_modules/.bin/glts"), "file");
  await writeFile(join(project, "helper.ts"), "export const name = 'detail';");
  await writeFile(join(project, "asset.glts"), `
    import * as THREE from 'three';
    import { scene, isPreview, onFrame } from '@drawcall/glts';
    import { name } from './helper.ts';
    const parent = new THREE.Mesh(new THREE.BoxGeometry(2,2,2), new THREE.MeshBasicMaterial({color:'red'}));
    parent.name = 'parent';
    const child = new THREE.Mesh(new THREE.SphereGeometry(.3), new THREE.MeshBasicMaterial({color:'lime'}));
    child.name = name;
    child.position.z = .75;
    parent.add(child);
    scene.add(parent);
    if (isPreview) {
      scene.background = new THREE.Color('black');
      scene.defaultCamera = new THREE.PerspectiveCamera(35, 1, .01, 100);
      scene.defaultCamera.position.set(4,3,6);
      scene.defaultCamera.lookAt(0,0,0);
    }
    onFrame(delta => { parent.position.x += delta; });
  `);
}, 30_000);

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: project });

it("runs the packaged commands through npx @drawcall/glts", async () => {
  const options = { cwd: project, env: { ...process.env, npm_config_offline: "true", npm_config_yes: "false" } };
  await exec("npx", ["@drawcall/glts", "render", "asset.glts", "-o", "npx.png", "--size", "32"], options);
  await exec("npx", ["@drawcall/glts", "export", "asset.glts", "-o", "npx.glb"], options);
  expect(await sharp(join(project, "npx.png")).metadata()).toMatchObject({ width: 32, height: 32 });
  expect((await readFile(join(project, "npx.glb"))).subarray(0, 4).toString()).toBe("glTF");
}, 30_000);

it("names itself from DRAWCALL_INVOCATION in help output", async () => {
  const help = (invocation?: string) => exec(process.execPath, [cli, "--help"], { cwd: project, env: { ...process.env, DRAWCALL_INVOCATION: invocation } });
  expect((await help("drawcall glts")).stdout).toMatch(/^Usage: drawcall glts \[options\] \[command\]/);
  expect((await help()).stdout).toMatch(/^Usage: glts \[options\] \[command\]/);
});

it("renders single-quoted assets/helpers, frames views at a simulation time, and isolates nested meshes", async () => {
  await run("render", "asset.glts", "-o", "hero.png", "--size", "64");
  expect(await sharp(join(project, "hero.png")).metadata()).toMatchObject({ width: 64, height: 64, format: "png" });
  await run("render", "asset.glts", "-o", "sheet.png", "--size", "64", "--time", "0.5", "--views", JSON.stringify([[{camera:"+z", isolate:"detail"}, {camera:"persp", focus:{center:[.5,0,.75], radius:.5}, title:"Region"}]]));
  expect(await sharp(join(project, "sheet.png")).metadata()).toMatchObject({ width: 128, height: 92 });
  const { data } = await sharp(join(project, "sheet.png")).extract({ left: 0, top: 0, width: 64, height: 64 }).raw().toBuffer({ resolveWithObject: true });
  let green = 0;
  let red = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if ((data[offset + 1] ?? 0) > 200 && (data[offset] ?? 0) < 20) green++;
    if ((data[offset] ?? 0) > 200 && (data[offset + 1] ?? 0) < 20) red++;
  }
  expect(green).toBeGreaterThan(100);
  expect(red).toBe(0);
}, 30_000);

it("resolves ESM-only project packages and their Three imports to the host instance", async () => {
  const dependency = join(project, "node_modules/esm-only");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), JSON.stringify({ type: "module", exports: { import: "./index.js" } }));
  await writeFile(join(dependency, "index.js"), "import {Mesh,BoxGeometry,MeshBasicMaterial} from 'three'; export const mesh = new Mesh(new BoxGeometry(),new MeshBasicMaterial());");
  await writeFile(join(project, "packages.glts"), "import {scene} from '@drawcall/glts'; import {mesh} from 'esm-only'; import {Mesh} from 'three'; if (!(mesh instanceof Mesh)) throw new Error('Multiple Three copies'); scene.add(mesh);");
  await run("export", "packages.glts", "-o", "packages.glb");
  const bytes = await readFile(join(project, "packages.glb"));
  expect(bytes.subarray(0, 4).toString()).toBe("glTF");
}, 30_000);

it("reports invalid views and load failures without replacing an existing output", async () => {
  const output = join(project, "existing.png");
  await writeFile(output, "original");
  await expect(run("render", "asset.glts", "-o", "existing.png", "--views", '[[{"camera":"front"}]]')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("View camera must be") });
  await expect(run("render", "missing.glts", "-o", "existing.png")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Unable to fetch source") });
  expect(await readFile(output, "utf8")).toBe("original");
  await writeFile(join(project, "broken.glts"), "import {scene,onDispose} from '@drawcall/glts'; import {Mesh,ShaderMaterial} from 'three'; scene.add(new Mesh(undefined,new ShaderMaterial())); onDispose(()=>{throw new Error('cleanup failed')});");
  await expect(run("export", "broken.glts", "-o", "broken.glb")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Cannot export ShaderMaterial") });
});

it("keeps native dependencies outside browser builds of the package root", async () => {
  await writeFile(join(project, "browser.js"), `export { GLTSLoader } from ${JSON.stringify(join(packageDir, "src/index.ts"))};`);
  const modules: string[] = [];
  await build({ configFile: false, logLevel: "silent", root: project, plugins: [{ name:"check-modules", moduleParsed(info) { modules.push(info.id); } }], build: { write: false, lib: { entry: join(project, "browser.js"), formats: ["es"] }, minify: false } });
  expect(modules.some(id => /\/cli\/|@drawcall\/webgl|@napi-rs\/canvas|\/sharp\//.test(id))).toBe(false);
}, 30_000);
