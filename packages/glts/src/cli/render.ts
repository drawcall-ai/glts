import type { Canvas } from "@drawcall/webgpu";
import sharp, { type OverlayOptions, type Sharp } from "sharp";
import * as THREE from "three/webgpu";
import { ItemCount } from "./count.js";
import { GLTSRenderer } from "../renderer/index.js";
import type { GLTSLoader } from "../loader/index.js";
import { writeHeadless } from "./headless.js";
import type { FocusSphere, View, ViewAngle } from "./views.js";

export interface RenderOptions {
  output: string;
  size: number;
  time: number;
  views?: View[][];
}

const captionHeight = 28;
const sheetColor = "#202733";

/**
 * A contact sheet of `rows` of views, each `size` pixels square and captioned below when there are several or any has
 * a title: the height of a row, and the sheet's background with the captions. The image rasterizes while the views
 * render, since rasterizing captions after them adds about 50 ms to a warm render, measured on an M2 Pro.
 */
function contactSheet(rows: View[][], size: number): { readonly height: number; readonly image: Promise<Sharp> } {
  const labeled = rows.flat().length > 1 || rows.some(row => row.some(view => view.title !== undefined));
  const height = size + (labeled ? captionHeight : 0);
  const captions = labeled ? rows.flatMap((row, top) => row.map((view, left) => {
    const title = view.title ? `${view.title} · ${view.camera}` : view.camera;
    const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    // A caption's own viewport clips it to its view's width.
    return `<svg x="${left * size}" y="${top * height + size}" width="${size}" height="${captionHeight}"><text x="8" y="19">${escaped}</text></svg>`;
  })) : [];
  const width = Math.max(...rows.map(row => row.length)) * size;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rows.length * height}"><rect width="100%" height="100%" fill="${sheetColor}"/><g font-family="sans-serif" font-size="13" fill="white">${captions.join("")}</g></svg>`;
  const image = sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => sharp(data, { raw: info }));
  // Awaited once the views rendered; a render failing first is the failure to report.
  image.catch(() => {});
  return { height, image };
}

export async function renderFile(file: string, options: RenderOptions): Promise<void> {
  await writeHeadless(file, options.output, true, options.size, (loader, url, canvas) => renderScene(loader, url, canvas, options));
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

/**
 * Holds three's node time, which TSL's `time` reads, at `seconds` for every render and compute, with no time passing
 * between them, so a view's image does not depend on when it was taken. Three offers no other public way to set it, so
 * this depends on the inspector's internal `nodeFrame`, which the CLI test of three's time at --time pins.
 */
class HeldTime extends THREE.InspectorBase {
  readonly #seconds: number;

  constructor(seconds: number) {
    super();
    this.#seconds = seconds;
  }

  override beginRender(): void { this.#hold(); }

  override beginCompute(): void { this.#hold(); }

  #hold(): void {
    this.nodeFrame.time = this.#seconds;
    this.nodeFrame.deltaTime = 0;
  }
}

/** Resolves once the GPU ran all work submitted to the device `canvas` was configured with. */
async function finished(canvas: Canvas): Promise<void> {
  const device = canvas.getContext("webgpu")?.getConfiguration()?.device;
  if (!device) throw new Error("The headless canvas is not configured.");
  await device.queue.onSubmittedWorkDone();
}

/** How long a view stays incomplete before stderr says what it waits for, and again each time that passes. */
const waitNoteInterval = 10_000;

/**
 * Repeats `pass` as frames would pass in the app until the view it draws is complete: two passes in a row start or
 * end no item while none is open. Two, since changes made during a render, after the affected object was drawn, reach
 * the GPU only at the next render. While items are open, a frame's time passes for them to progress; with none open,
 * the next pass follows once pending tasks ran. How long content may take is the caller's to limit, so a view that
 * stays incomplete is noted on stderr rather than failed.
 */
async function complete(items: ItemCount, pass: () => void | Promise<void>): Promise<void> {
  let noted = performance.now();
  for (let quiet = 0; quiet < 2;) {
    const { changes } = items;
    await pass();
    await new Promise((resolve) => items.open > 0 ? setTimeout(resolve, 16) : setImmediate(resolve));
    items.throwFailures();
    quiet = items.changes === changes && items.open === 0 ? quiet + 1 : 0;
    if (performance.now() - noted < waitNoteInterval) continue;
    noted = performance.now();
    console.error(items.open > 0
      ? `Still waiting for ${items.open} item(s) to finish loading.`
      : "Still waiting for a render that starts no item.");
  }
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

async function renderScene(loader: GLTSLoader, url: URL, canvas: Canvas, { size, time, views }: RenderOptions): Promise<Uint8Array> {
  // Counted from before the load: a nested script's late items reach the host's manager while its parent still loads.
  const items = new ItemCount(loader.manager);
  const scene = await loader.loadAsync(url);
  // What the load left streaming in, such as later nested loads, arrives first, so frame callbacks step it too.
  await complete(items, () => {});
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
  const sheet = contactSheet(rows, size);
  // Three's DOM canvas types exclude native canvases; its constructor checks the actual API.
  // Constructed as the skill recommends hosts construct theirs, so views draw as they would in the app.
  const instance: unknown = Reflect.construct(THREE.WebGPURenderer, [{ canvas, alpha: false, antialias: true, reversedDepthBuffer: true }]);
  if (!(instance instanceof THREE.WebGPURenderer)) throw new Error("Unable to construct the headless renderer.");
  const renderer = instance;
  try {
    await renderer.init();
    renderer.inspector = new HeldTime(time);
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    // The contact sheet is opaque; compose transparency on the GPU against its backdrop.
    renderer.setClearColor(sheetColor, 1);
    const tiles: OverlayOptions[] = [];
    for (const [row, rowShots] of shots.entries()) for (const [column, shot] of rowShots.entries()) {
      const restore = shot.isolated ? isolate(scene, shot.isolated) : () => {};
      const gltsRenderer = new GLTSRenderer(renderer);
      try {
        // A render requests all a view draws, its shadows included; renders repeat, as frames in the app would, until
        // they request nothing, and the image is the last. Each waits for the GPU, as a browser paces frames, so slow
        // GPUs do not queue frames for the readback to wait on.
        await complete(items, async () => {
          gltsRenderer.render(scene, shot.camera);
          await finished(canvas);
        });
        const pixels = await canvas.readPixels();
        // Native readback keeps attachment alpha; opaque canvas presentation ignores it.
        for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
        const input = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        tiles.push({ input, raw: { width: size, height: size, channels: 4 }, left: column * size, top: row * sheet.height });
      } finally {
        try { gltsRenderer.dispose(); }
        finally { restore(); }
      }
    }
    return await (await sheet.image).composite(tiles).png().toBuffer();
  } finally {
    await renderer.dispose();
  }
}
