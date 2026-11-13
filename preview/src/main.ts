// Loads the asset at `?url=<asset.glts>` (served with CORS) with `isPreview: true` and renders
// it every frame with its `defaultCamera` or a camera fitted to its bounds, then logs "ready"
// once what it streams in has arrived, or logs and shows the error. A .glts file dropped
// anywhere on the page, or picked when no URL was given, replaces the shown asset the same way.
import { GLTSLoader, GLTSRenderer, type GLTSScene } from "@drawcall/glts";
import * as THREE from "three/webgpu";

const hint = element("#hint", HTMLElement);
const picker = element("#picker", HTMLInputElement);

let failed = false;
let output: HTMLPreElement | undefined;
addEventListener("error", (event) =>
  fail(event.error ?? new Error(event.message || "The preview failed.")),
);
addEventListener("unhandledrejection", (event) => fail(event.reason));

const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true });
renderer.onDeviceLost = (info) => fail(new Error(info.message));
await renderer.init();
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.setClearColor(0x111111);
document.body.prepend(renderer.domElement);
const glts = new GLTSRenderer(renderer);
const timer = new THREE.Timer();

// Content can stream in after a scene's load resolves, as items on the manager, such as
// @drawcall/lod's levels, which load and appear only while frames render. `activity` counts
// the items' starts and ends, so that "ready" waits for a frame in which none started or ended.
const manager = new THREE.LoadingManager();
let loading = false;
let activity = 0;
manager.onStart = () => {
  loading = true;
  activity += 1;
};
manager.onProgress = () => {
  activity += 1;
};
manager.onLoad = () => {
  loading = false;
  activity += 1;
};

const loader = new GLTSLoader(manager, { isPreview: true });
let current:
  | { scene: GLTSScene; camera: THREE.Camera; activity: number; ready: boolean }
  | undefined;
// Counts loads so a slower earlier load never replaces a later one.
let loads = 0;
renderer.setAnimationLoop(render);

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  picker.value = "";
  if (file) void showFile(file);
});
bindDrop();

const url = new URLSearchParams(location.search).get("url");
if (url) void show(url);
else hint.hidden = false;

async function showFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith(".glts")) {
    fail(new Error(`${file.name} is not a .glts file.`));
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    await show(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function show(url: string): Promise<void> {
  const load = ++loads;
  hint.hidden = true;
  failed = false;
  output?.remove();
  try {
    const scene = await loader.loadAsync(url);
    if (load !== loads) {
      scene.dispose();
      return;
    }
    current?.scene.dispose();
    current = { scene, camera: scene.defaultCamera ?? fitCamera(scene), activity: -1, ready: false };
  } catch (error) {
    if (load === loads) fail(error);
  }
}

function render(): void {
  timer.update();
  if (!current) return;
  current.scene.update(timer.getDelta());
  glts.render(current.scene, current.camera);
  if (!current.ready && !loading && current.activity === activity) {
    current.ready = true;
    if (!failed) console.log("ready");
  }
  current.activity = activity;
}

function element<T extends Element>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`The preview page is missing ${selector}.`);
  return found;
}

/** Makes the whole page a drop target for one .glts file. */
function bindDrop(): void {
  // Counts nested dragenter/dragleave pairs so crossing child elements keeps the highlight.
  let depth = 0;
  const files = (event: DragEvent) =>
    event.dataTransfer?.types.includes("Files") ? event.dataTransfer.files : undefined;

  addEventListener("dragenter", (event) => {
    if (!files(event)) return;
    event.preventDefault();
    depth += 1;
    document.body.dataset.dragging = "";
  });
  addEventListener("dragover", (event) => {
    if (!files(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  addEventListener("dragleave", (event) => {
    if (!files(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) delete document.body.dataset.dragging;
  });
  addEventListener("drop", (event) => {
    const dropped = files(event);
    if (!dropped) return;
    event.preventDefault();
    depth = 0;
    delete document.body.dataset.dragging;
    const file = dropped.item(0);
    if (dropped.length !== 1 || !file) {
      fail(new Error("Drop one self-contained .glts file at a time."));
      return;
    }
    void showFile(file);
  });
}

/** Frames the scene's bounds from a three-quarter view. */
function fitCamera(scene: THREE.Object3D): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000);
  const bounds = new THREE.Box3().setFromObject(scene);
  if (bounds.isEmpty()) {
    camera.position.set(4, 3, 6);
    camera.lookAt(0, 0, 0);
    return camera;
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const distance =
    Math.max(radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), 1) * 1.25;
  camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.6, distance));
  camera.near = Math.max(distance / 1_000, 0.01);
  camera.far = Math.max(distance * 1_000, 10_000);
  camera.lookAt(center);
  return camera;
}

/** Shows the first error until the next load; later errors only reach the console. */
function fail(error: unknown): void {
  console.error(error);
  if (failed) return;
  failed = true;
  output = document.createElement("pre");
  output.textContent = describe(error);
  document.body.append(output);
}

function describe(error: unknown): string {
  const lines: string[] = [];
  for (let cause = error; cause !== undefined; ) {
    if (!(cause instanceof Error)) {
      lines.push(String(cause));
      break;
    }
    lines.push(cause.stack ?? cause.message);
    cause = cause.cause;
  }
  return lines.join("\nCaused by: ");
}
