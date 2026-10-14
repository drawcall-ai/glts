import { createCanvas } from "@drawcall/webgl";
import sharp from "sharp";
import * as THREE from "three";
import { GLTSRenderer } from "../renderer/index.js";
import type { GLTSScene } from "../types.js";
import { fitCamera, focusSphere, isolate, named } from "./camera.js";
import type { View } from "./views.js";

export interface RenderOptions {
  size: number;
  time: number;
  views?: View[][];
}

function caption(text: string, size: number): Buffer {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return Buffer.from(`<svg width="${size}" height="28"><rect width="100%" height="100%" fill="#202733"/><text x="8" y="19" font-family="sans-serif" font-size="13" fill="white">${escaped}</text></svg>`);
}

export async function renderScene(scene: GLTSScene, { size, time, views }: RenderOptions): Promise<Uint8Array> {
  scene.update(0);
  for (let elapsed = 0; elapsed < time;) {
    const delta = Math.min(1 / 60, time - elapsed);
    scene.update(delta);
    elapsed += delta;
  }
  scene.updateMatrixWorld(true);
  const authored = views === undefined ? scene.defaultCamera : undefined;
  const rows = views ?? [[{ camera: "persp" }]];
  const shots = rows.map(row => row.map(view => {
    const isolated = view.isolate === undefined ? undefined : named(scene, view.isolate);
    const camera = authored ?? fitCamera(view.camera, focusSphere(scene, view.focus, isolated));
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
    for (const [row, list] of shots.entries()) for (const [column, shot] of list.entries()) {
      const restore = shot.isolated ? isolate(scene, shot.isolated) : () => {};
      const pipeline = new GLTSRenderer(renderer);
      try {
        pipeline.render(scene, shot.camera, 0);
        const input = await sharp(canvas.readPixels(), { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
        tiles.push({ input, left: column * size, top: row * height });
      } finally { pipeline.dispose(); restore(); }
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
