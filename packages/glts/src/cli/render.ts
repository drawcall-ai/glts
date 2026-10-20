import { createCanvas } from "@drawcall/webgl";
import sharp from "sharp";
import * as THREE from "three";
import { GLTSRenderer } from "../renderer/index.js";
import type { GLTSScene } from "../types.js";
import { writeHeadless } from "./headless.js";
import type { FocusSphere, View, ViewAngle } from "./views.js";

export interface RenderOptions {
  output: string;
  size: number;
  time: number;
  views?: View[][];
}

function caption(text: string, size: number): Buffer {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return Buffer.from(`<svg width="${size}" height="28"><rect width="100%" height="100%" fill="#202733"/><text x="8" y="19" font-family="sans-serif" font-size="13" fill="white">${escaped}</text></svg>`);
}

export async function renderFile(file: string, options: RenderOptions): Promise<void> {
  await writeHeadless(file, options.output, true, (scene) => renderScene(scene, options));
}

function findUnique(scene: THREE.Object3D, name: string): THREE.Object3D {
  const matches: THREE.Object3D[] = [];
  scene.traverse(object => { if (object.name === name) matches.push(object); });
  const [object] = matches;
  if (!object) throw new Error(`Unknown object "${name}".`);
  if (matches.length !== 1) throw new Error(`Ambiguous object "${name}": names must be unique.`);
  return object;
}

function bounds(object: THREE.Object3D): THREE.Sphere {
  const box = new THREE.Box3().setFromObject(object, true);
  if (box.isEmpty()) throw new Error(`No geometry to frame in "${object.name || "scene"}"; use sphere focus for bones or empty groups.`);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius)) throw new Error("Scene bounds are not finite.");
  sphere.radius = Math.max(sphere.radius, 0.001);
  return sphere;
}

function focusSphere(scene: THREE.Object3D, focus: string | FocusSphere | undefined, isolated?: THREE.Object3D): THREE.Sphere {
  if (typeof focus === "string") return bounds(findUnique(scene, focus));
  if (focus) return new THREE.Sphere(new THREE.Vector3(...focus.center), focus.radius);
  return bounds(isolated ?? scene);
}

function fitCamera(angle: ViewAngle, sphere: THREE.Sphere): THREE.Camera {
  const { center, radius } = sphere;
  const direction = new THREE.Vector3();
  if (angle === "persp") direction.set(1, 0.6, 1).normalize();
  else direction.setComponent("xyz".indexOf(angle.charAt(1)), angle.startsWith("+") ? 1 : -1);
  const half = radius * 1.12;
  const camera = angle === "persp"
    ? new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 1000)
    : new THREE.OrthographicCamera(-half, half, half, -half, radius / 100, radius * 1000);
  if (angle === "+y" || angle === "-y") camera.up.set(0, 0, angle === "+y" ? -1 : 1);
  const distance = angle === "persp" ? half / Math.sin(THREE.MathUtils.degToRad(17.5)) : radius * 5;
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  return camera;
}

function isolate(scene: THREE.Object3D, selected: THREE.Object3D): () => void {
  const keep = new Set<THREE.Object3D>();
  selected.traverse(object => keep.add(object));
  scene.traverse(object => { if (object instanceof THREE.Light) keep.add(object); });
  const masks = new Map<THREE.Object3D, number>();
  scene.traverse(object => {
    masks.set(object, object.layers.mask);
    // Layer filtering suppresses ancestor geometry while still traversing its children.
    if (!keep.has(object)) object.layers.mask = 0;
  });
  return () => { for (const [object, mask] of masks) object.layers.mask = mask; };
}

async function renderScene(scene: GLTSScene, { size, time, views }: RenderOptions): Promise<Uint8Array> {
  scene.update(0);
  for (let elapsed = 0; elapsed < time;) {
    const delta = Math.min(1 / 60, time - elapsed);
    scene.update(delta);
    elapsed += delta;
  }
  scene.updateMatrixWorld(true);
  const defaultCamera = views === undefined ? scene.defaultCamera : undefined;
  const rows = views ?? [[{ camera: "persp" }]];
  const shots = rows.map(row => row.map(view => {
    const isolated = view.isolate === undefined ? undefined : findUnique(scene, view.isolate);
    const camera = defaultCamera ?? fitCamera(view.camera, focusSphere(scene, view.focus, isolated));
    return { view, camera, isolated };
  }));
  const canvas = createCanvas(size, size);
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    // Three's DOM canvas types exclude native canvases; its constructor checks the actual API.
    const instance: unknown = Reflect.construct(THREE.WebGLRenderer, [{ canvas, ...GLTSRenderer.parameters, antialias: false }]);
    if (!(instance instanceof THREE.WebGLRenderer)) throw new Error("Unable to construct the headless renderer.");
    renderer = instance;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      throw new Error(`Shader compilation failed:\n${gl.getProgramInfoLog(program)}\n${gl.getShaderInfoLog(vertex)}\n${gl.getShaderInfoLog(fragment)}`);
    };
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    const tiles: sharp.OverlayOptions[] = [];
    const labeled = shots.flat().length > 1 || shots.some(row => row.some(shot => shot.view.title !== undefined));
    const height = size + (labeled ? 28 : 0);
    for (const [row, rowShots] of shots.entries()) for (const [column, shot] of rowShots.entries()) {
      const restore = shot.isolated ? isolate(scene, shot.isolated) : () => {};
      const gltsRenderer = new GLTSRenderer(renderer);
      try {
        gltsRenderer.render(scene, shot.camera, 0);
        const input = await sharp(canvas.readPixels(), { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
        tiles.push({ input, left: column * size, top: row * height });
      } finally { gltsRenderer.dispose(); restore(); }
      if (labeled) {
        const title = shot.view.title ? `${shot.view.title} · ${shot.view.camera}` : shot.view.camera;
        tiles.push({ input: caption(title, size), left: column * size, top: row * height + size });
      }
    }
    const width = Math.max(...rows.map(row => row.length)) * size;
    return await sharp({ create: { width, height: rows.length * height, channels: 4, background: "#202733" } }).composite(tiles).png().toBuffer();
  } finally {
    try { renderer?.dispose(); }
    finally { canvas.destroy(); }
  }
}
