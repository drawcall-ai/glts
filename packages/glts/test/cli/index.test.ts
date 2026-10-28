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
  expect((await help()).stdout).toMatch(/^Usage: npx @drawcall\/glts \[options\] \[command\]/);
});

it("renders single-quoted scripts/helpers, frames views at a simulation time, and isolates nested meshes", async () => {
  const { stderr } = await run("render", "asset.glts", "-o", "hero.png", "--size", "64");
  expect(stderr).not.toContain("Invalid asm.js");
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

it("renders and exports native bitmap textures loaded before the renderer exists", async () => {
  await sharp({ create: { width: 4, height: 4, channels: 4, background: "#00ff20" } }).png().toFile(join(project, "texture.png"));
  await writeFile(join(project, "textured.glts"), `
    import * as THREE from 'three/webgpu';
    import { scene, loadingManager, onDispose } from '@drawcall/glts';
    const bitmap = await new THREE.ImageBitmapLoader(loadingManager).loadAsync(new URL('./texture.png', import.meta.url).href);
    const map = new THREE.Texture(bitmap);
    map.needsUpdate = true;
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial({ map });
    scene.add(new THREE.Mesh(geometry, material));
    onDispose(() => { geometry.dispose(); material.dispose(); map.dispose(); bitmap.close(); });
  `);
  await run("render", "textured.glts", "-o", "textured.png", "--size", "32");
  const { data } = await sharp(join(project, "textured.png")).raw().toBuffer({ resolveWithObject: true });
  let green = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if ((data[offset + 1] ?? 0) > 200 && (data[offset] ?? 0) < 20) green++;
  }
  expect(green).toBeGreaterThan(40);
  await run("export", "textured.glts", "-o", "textured.glb");
  const bytes = await readFile(join(project, "textured.glb"));
  const json: unknown = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  expect(json).toMatchObject({ images: [{ mimeType: "image/png" }], textures: [{ source: 0 }] });
  const imageOffset = bytes.indexOf(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(imageOffset).toBeGreaterThan(0);
  const pixels = await sharp(bytes.subarray(imageOffset)).raw().toBuffer();
  expect(Array.from(pixels.subarray(0, 4))).toEqual([0, 255, 32, 255]);
}, 30_000);

it("renders node materials through native TSL bloom and chained effects", async () => {
  await writeFile(join(project, "effects.glts"), `
    import * as THREE from 'three/webgpu';
    import { vec4 } from 'three/tsl';
    import { bloom } from 'three/addons/tsl/display/BloomNode.js';
    import { scene, onDispose } from '@drawcall/glts';
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec4(1, 0, 0, 1);
    scene.add(new THREE.Mesh(geometry, material));
    scene.defaultCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    scene.defaultCamera.position.z = 2;
    scene.rendering.effects.push(
      ({ input }) => input.add(bloom(input)),
      ({ input }) => vec4(input.b, input.r, input.g, input.a),
    );
    onDispose(() => { geometry.dispose(); material.dispose(); });
  `);
  await run("render", "effects.glts", "-o", "effects.png", "--size", "16");
  const pixel = await sharp(join(project, "effects.png")).extract({ left: 8, top: 8, width: 1, height: 1 }).raw().toBuffer();
  expect(Array.from(pixel)).toEqual([0, 255, 0, 255]);
}, 30_000);

it("exports canvas textures created by the script", async () => {
  await writeFile(join(project, "canvas.glts"), `
    import { BoxGeometry, CanvasTexture, Mesh, MeshBasicMaterial } from "three";
    import { onDispose, scene } from "@drawcall/glts";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing 2D context");
    context.fillStyle = "#00ff20";
    context.fillRect(0, 0, 4, 4);
    const texture = new CanvasTexture(canvas);
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial({ map: texture });
    scene.add(new Mesh(geometry, material));
    onDispose(() => { geometry.dispose(); material.dispose(); texture.dispose(); });
  `);
  await run("export", "canvas.glts", "-o", "canvas.glb");
  const bytes = await readFile(join(project, "canvas.glb"));
  const imageOffset = bytes.indexOf(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(imageOffset).toBeGreaterThan(0);
  const pixels = await sharp(bytes.subarray(imageOffset)).raw().toBuffer();
  expect(Array.from(pixels.subarray(0, 4))).toEqual([0, 255, 32, 255]);
}, 30_000);

it("reports invalid views and load failures without replacing an existing output", async () => {
  const output = join(project, "existing.png");
  await writeFile(output, "original");
  await expect(run("render", "asset.glts", "-o", "existing.png", "--views", '[[{"camera":"front"}]]')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("View camera must be") });
  await expect(run("render", "missing.glts", "-o", "existing.png")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Request failed with 404") });
  expect(await readFile(output, "utf8")).toBe("original");
  await writeFile(join(project, "broken.glts"), "import {scene,onDispose} from '@drawcall/glts'; import {Mesh,ShaderMaterial} from 'three'; scene.add(new Mesh(undefined,new ShaderMaterial())); onDispose(()=>{throw new Error('cleanup failed')});");
  await expect(run("export", "broken.glts", "-o", "broken.glb")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Cannot export ShaderMaterial") });
});

it("keeps native packages outside browser builds of the package root", async () => {
  await writeFile(join(project, "browser.js"), `export { GLTSLoader } from ${JSON.stringify(join(packageDir, "src/index.ts"))};`);
  const modules: string[] = [];
  await build({ configFile: false, logLevel: "silent", root: project, plugins: [{ name:"check-modules", moduleParsed(info) { modules.push(info.id); } }], build: { write: false, lib: { entry: join(project, "browser.js"), formats: ["es"] }, minify: false } });
  expect(modules.some(id => /\/cli\/|\/headless\/|@drawcall\/webgpu|@napi-rs\/canvas|\/sharp\//.test(id))).toBe(false);
}, 30_000);
