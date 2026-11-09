import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const front = "scene.defaultCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); scene.defaultCamera.position.z = 2;";
const above = "scene.defaultCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 3); scene.defaultCamera.position.y = 2; scene.defaultCamera.lookAt(0, 0, 0);";
const green = [0, 255, 0, 255];

/**
 * Writes `files` into the project's directory `name` and renders the first of them, or `script`, at 8 pixels with
 * `args` and the process environment overridden by `env`; the image's centre pixel and its PNG.
 */
async function render(name: string, files: Record<string, string | Buffer>, { script, args = [], env = {} }: { script?: string; args?: string[]; env?: Record<string, string> } = {}): Promise<{ centre: number[]; png: Buffer }> {
  const cwd = join(project, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  const output = `${randomUUID()}.png`;
  await exec(process.execPath, [cli, "render", script ?? Object.keys(files)[0] ?? "", "-o", output, "--size", "8", ...args], { cwd, env: { ...process.env, ...env } });
  const png = await readFile(join(cwd, output));
  const centre = Array.from(await sharp(png).extract({ left: 4, top: 4, width: 1, height: 1 }).raw().toBuffer());
  return { centre, png };
}

it("captures alpha-to-coverage over the scene background without compositing the sheet through it", async () => {
  const { centre } = await render("coverage", { "coverage.glts": `
    import * as THREE from 'three/webgpu';
    import { vec4 } from 'three/tsl';
    import { scene } from '@drawcall/glts';
    const material = new THREE.MeshBasicNodeMaterial({ alphaToCoverage: true });
    material.colorNode = vec4(1, 1, 1, 0.5);
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    scene.background = new THREE.Color('black');
    ${front}
  ` });
  expect(centre[0]).toBeGreaterThan(80);
  expect(centre[0]).toBeLessThan(240);
  expect(centre).toEqual([centre[0], centre[0], centre[0], 255]);
}, 30_000);

it("composes ordinary transparency over the sheet background through effects", async () => {
  const { centre, png } = await render("transparent", { "transparent.glts": `
    import * as THREE from 'three/webgpu';
    import { scene } from '@drawcall/glts';
    const material = new THREE.MeshBasicMaterial({ color: 'red', opacity: 0.5, transparent: true });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));
    scene.rendering.effects.push(({ input }) => input);
    ${front}
  ` });
  const corner = Array.from(await sharp(png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer());
  expect(corner).toEqual([32, 39, 51, 255]);
  // The effect receives linear scene colour: half red plus half the opaque backdrop.
  const linear = (byte: number) => { const value = byte / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  const expected = [0.5 + linear(32) * 0.5, linear(39) * 0.5, linear(51) * 0.5];
  expected.forEach((value, channel) => expect(linear(centre[channel] ?? 0)).toBeCloseTo(value, 2));
  expect(centre[3]).toBe(255);
}, 30_000);

it("runs scripts as the Vite dev server serves the app's public directory, rendering each view once what it streams in, and what that streams in, arrived", async () => {
  const color = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#00ff20" } }).png().toBuffer();
  const { centre } = await render("app", { "public/streamed.glts": `
    import * as THREE from 'three/webgpu';
    import { scene, loadingManager } from '@drawcall/glts';
    if (import.meta.env.MODE !== 'development' || !import.meta.env.DEV || !import.meta.env.SSR || import.meta.env.BASE_URL !== '/') throw new Error('Not Vite dev env');
    const loaded = await new THREE.ImageBitmapLoader(loadingManager).loadAsync('/color.png');
    const streamed = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 'white' }));
    // Streams in what a view draws, a few frames later: first a stand-in, which, once drawn, streams in its texture.
    const stream = (url, arrive) => {
      streamed.onBeforeRender = () => {
        streamed.onBeforeRender = () => {};
        loadingManager.itemStart(url);
        setTimeout(() => { arrive(); loadingManager.itemEnd(url); }, 50);
      };
    };
    stream('stand-in', () => {
      streamed.material = new THREE.MeshBasicMaterial({ color: 'red' });
      stream('texture', () => {
        streamed.material.color.set('white');
        streamed.material.map = new THREE.Texture(loaded);
        streamed.material.map.colorSpace = THREE.SRGBColorSpace;
        streamed.material.map.needsUpdate = true;
        streamed.material.needsUpdate = true;
      });
    });
    scene.add(streamed);
    ${front}
  `, "public/color.png": color });
  expect(centre).toEqual([0, 255, 32, 255]);
}, 30_000);

it("renders and fails with what a nested script streams in once its own load settled, and exports none of it", async () => {
  const child = (end: string, later = true) => `
    import * as THREE from 'three/webgpu';
    import { scene, loadingManager } from '@drawcall/glts';
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 'red' }));
    scene.add(mesh);
    scene.userData.stream = () => {
      loadingManager.itemStart('part');
      const finish = () => { ${end} loadingManager.itemEnd('part'); };
      ${later ? "setTimeout(finish, 50);" : "finish();"}
    };
  `;
  const parent = (url: string) => `
    import * as THREE from 'three/webgpu';
    import { scene, gltsLoader } from '@drawcall/glts';
    const child = await gltsLoader.loadAsync('${url}');
    scene.add(child);
    child.userData.stream();
    ${front}
  `;
  const files = {
    "streamed.glts": parent("./streams.glts"), "failing.glts": parent("./fails.glts"),
    "streams.glts": child("mesh.material.color.set('#00ff00');"), "fails.glts": child("loadingManager.itemError('part');"),
    "failed.glts": parent("./fails-at-once.glts"), "fails-at-once.glts": child("loadingManager.itemError('part');", false),
  };
  expect((await render("nested", files)).centre).toEqual(green);
  await expect(render("nested", files, { script: "failing.glts" }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Items failed to load:\n- part") });
  await expect(exec(process.execPath, [cli, "export", "streamed.glts", "-o", "streamed.glb"], { cwd: join(project, "nested") }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("1 item(s) started after the script's load settled were still loading") });
  // Failed and ended before the load resolved, so none is open.
  await expect(exec(process.execPath, [cli, "export", "failed.glts", "-o", "failed.glb"], { cwd: join(project, "nested") }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Items failed to load:\n- part") });
}, 30_000);

it("renders what a view draws only for its shadows once that arrived", async () => {
  const { centre } = await render("shadow", { "shadow.glts": `
    import * as THREE from 'three/webgpu';
    import { scene, loadingManager } from '@drawcall/glts';
    scene.rendering.shadows = true;
    const light = new THREE.DirectionalLight('white', 3);
    light.position.set(0, 10, 0);
    light.castShadow = true;
    scene.add(light, light.target);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: 'black', emissive: 'red' }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    // Outside the view: drawn only into the light's shadow map.
    const caster = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    caster.position.y = 5;
    caster.castShadow = true;
    caster.onBeforeRender = () => {
      caster.onBeforeRender = () => {};
      loadingManager.itemStart('part');
      setTimeout(() => { floor.material.emissive.set('#00ff00'); loadingManager.itemEnd('part'); }, 50);
    };
    scene.add(caster);
    ${above}
  ` });
  expect(centre).toEqual(green);
}, 30_000);

it("renders instances placed during a render after they were drawn", async () => {
  const { centre } = await render("instances", { "instances.glts": `
    import * as THREE from 'three/webgpu';
    import { scene } from '@drawcall/glts';
    // More matrices than a uniform buffer holds, all hidden until the placer, drawn after them, places one.
    const count = 20000;
    const plane = new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2);
    const instances = new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ color: '#00ff00' }), count);
    for (let i = 0; i < count; i++) instances.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    instances.frustumCulled = false;
    const placer = new THREE.Mesh(new THREE.PlaneGeometry(0, 0), new THREE.MeshBasicMaterial());
    placer.renderOrder = 1;
    placer.frustumCulled = false;
    placer.onBeforeRender = () => {
      placer.onBeforeRender = () => {};
      instances.setMatrixAt(0, new THREE.Matrix4());
      instances.instanceMatrix.needsUpdate = true;
    };
    scene.add(instances, placer);
    ${above}
  ` });
  expect(centre).toEqual(green);
}, 30_000);

it("waits for the GPU after each render, so no frames queue for the image", async () => {
  await render("paced", { "paced.glts": `
    import * as THREE from 'three/webgpu';
    import { Fn, Loop, float, sin, vec4 } from 'three/tsl';
    import { scene, loadingManager } from '@drawcall/glts';
    // A slow GPU: each pixel loops long enough that frames would queue without the wait, the fewest iterations that
    // caught it in every run on Metal (10 000 missed one in five), so a software adapter stays quick.
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = Fn(() => {
      const value = float(0).toVar();
      Loop(100000, ({ i }) => { value.assign(sin(value.add(float(i)))); });
      return vec4(value.mul(1e-9), 1, 0, 1);
    })();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    // The first renders each request an item, so renders repeat; each checks how many before it the GPU still runs.
    let started = 0;
    let finished = 0;
    plane.onBeforeRender = (renderer) => {
      const frame = ++started;
      const queued = frame - 1 - finished;
      if (queued > 1) throw new Error(queued + ' frames queued');
      // Three configures the canvas once a render first presents to it, after the first frame's objects drew.
      renderer.domElement.getContext('webgpu').getConfiguration()?.device.queue.onSubmittedWorkDone().then(() => { finished = Math.max(finished, frame - 1); });
      if (frame > 6) return;
      loadingManager.itemStart('frame');
      loadingManager.itemEnd('frame');
    };
    scene.add(plane);
    ${front}
  ` });
});

it("keeps far surfaces in depth order across a deep view", async () => {
  const { centre } = await render("depth", { "depth.glts": `
    import * as THREE from 'three/webgpu';
    import { scene } from '@drawcall/glts';
    // A metre apart at twenty kilometres, under a near plane of a decimetre: the farther one draws last.
    const quad = (color, z, order) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshBasicMaterial({ color }));
      mesh.position.z = z;
      mesh.renderOrder = order;
      return mesh;
    };
    scene.add(quad('#00ff00', -20000, 0), quad('#ff0000', -20001, 1));
    scene.defaultCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 1e6);
  ` });
  expect(centre).toEqual(green);
}, 30_000);

it("renders and computes with three's time at --time, whenever the view finished loading", async () => {
  const renders = { "renders.glts": `
    import * as THREE from 'three/webgpu';
    import { time } from 'three/tsl';
    import { scene, loadingManager } from '@drawcall/glts';
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = time.mul(0.37);
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    loadingManager.itemStart('slow');
    setTimeout(() => loadingManager.itemEnd('slow'), Number(import.meta.env.VITE_DELAY));
    ${front}
  ` };
  const at = { args: ["--time", "1"] };
  const fast = await render("time", renders, { ...at, env: { VITE_DELAY: "0" } });
  expect(await render("time", renders, { ...at, env: { VITE_DELAY: "0" } })).toEqual(fast);
  expect(await render("time", renders, { ...at, env: { VITE_DELAY: "500" } })).toEqual(fast);
  // 0.37 in linear light, as sRGB.
  expect(fast.centre).toEqual([164, 164, 164, 255]);
  const { centre } = await render("time", { "computes.glts": `
    import * as THREE from 'three/webgpu';
    import { Fn, fract, storage, time } from 'three/tsl';
    import { scene, loadingManager } from '@drawcall/glts';
    // Dispatched between renders, a compute writes the time into what the plane shows, fast enough to show any drift.
    const buffer = new THREE.StorageBufferAttribute(new Float32Array(1), 1);
    const write = Fn(() => { storage(buffer, 'float', 1).element(0).assign(fract(time.mul(50))); })().compute(1);
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = storage(buffer, 'float', 1).toReadOnly().element(0);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    plane.onBeforeRender = (renderer) => {
      plane.onBeforeRender = () => {};
      loadingManager.itemStart('compute');
      setTimeout(() => { renderer.compute(write); loadingManager.itemEnd('compute'); }, 50);
    };
    scene.add(plane);
    ${front}
  ` }, { args: ["--time", "1.01"] });
  // 0.5 in linear light, as sRGB.
  expect(centre).toEqual([188, 188, 188, 255]);
}, 60_000);

it("reads the VITE_ variables of Vite's development .env files, which the process environment overrides", async () => {
  const directory = join(project, "env");
  await mkdir(directory);
  await writeFile(join(directory, ".env"), "VITE_A=env\nVITE_B=env\nVITE_C=env\nSECRET=env");
  await writeFile(join(directory, ".env.development.local"), "VITE_B=local");
  await writeFile(join(directory, ".env.production"), "VITE_A=production");
  await writeFile(join(directory, ".env.example"), "VITE_A=example");
  await writeFile(join(directory, "env.glts"), `
    const { VITE_A, VITE_B, VITE_C, SECRET } = import.meta.env;
    if (VITE_A !== 'env' || VITE_B !== 'local' || VITE_C !== 'process' || SECRET !== undefined) throw new Error(JSON.stringify(import.meta.env));
  `);
  await exec(process.execPath, [cli, "export", "env.glts", "-o", "env.glb"], { cwd: directory, env: { ...process.env, VITE_C: "process" } });
});

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
  const { centre } = await render("effects", { "effects.glts": `
    import * as THREE from 'three/webgpu';
    import { vec4 } from 'three/tsl';
    import { bloom } from 'three/addons/tsl/display/BloomNode.js';
    import { scene, onDispose } from '@drawcall/glts';
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec4(1, 0, 0, 1);
    scene.add(new THREE.Mesh(geometry, material));
    ${front}
    scene.rendering.effects.push(
      ({ input }) => input.add(bloom(input)),
      ({ input }) => vec4(input.b, input.r, input.g, input.a),
    );
    onDispose(() => { geometry.dispose(); material.dispose(); });
  ` });
  expect(centre).toEqual(green);
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
