import { GLTSLoader, GLTSRenderer, type GLTSScene } from "@drawcall/glts";
import "@fontsource-variable/newsreader";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import "./style.css";

interface Showcase {
  readonly label: string;
  readonly strength: string;
  readonly target: readonly [number, number, number];
  readonly url: string;
}

interface LoadedScene {
  readonly objectURL: string | undefined;
  readonly scene: GLTSScene;
}

interface ElementConstructor<T extends Element> {
  new (): T;
}

const showcase = {
  label: "Vintage Racecar",
  strength: "Multi-file composition",
  target: [0, 0.45, 0.08],
  url: "/assets/showcases/vintage-racecar/index.glts"
} as const satisfies Showcase;

function requiredElement<T extends Element>(
  selector: string,
  ElementType: ElementConstructor<T>
): T {
  const element = document.querySelector(selector);
  if (!(element instanceof ElementType)) {
    throw new Error(`Required element is missing: ${selector}`);
  }
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const canvas = requiredElement("#scene", HTMLCanvasElement);
const viewer = requiredElement("#viewer", HTMLElement);
const fileInput = requiredElement("#file-input", HTMLInputElement);
const status = requiredElement("#status", HTMLElement);
const statusDot = requiredElement("#status-dot", HTMLElement);
const stats = requiredElement("#stats", HTMLElement);
const progressBar = requiredElement("#progress-bar", HTMLElement);
const showcaseButton = requiredElement("[data-showcase]", HTMLButtonElement);

const renderer = new THREE.WebGLRenderer({
  ...GLTSRenderer.parameters,
  antialias: true,
  canvas
});
const gltsRenderer = new GLTSRenderer(renderer);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x080a10);
renderer.info.autoReset = false;

const fallbackCamera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
let camera: THREE.Camera = fallbackCamera;

function createControls(camera: THREE.Camera): OrbitControls {
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 0.5;
  controls.maxDistance = 240;
  controls.maxPolarAngle = Math.PI * 0.98;
  return controls;
}

let controls = createControls(camera);

const loadingManager = new THREE.LoadingManager();
loadingManager.onStart = () => {
  progressBar.dataset.state = "active";
  progressBar.style.transform = "scaleX(0.08)";
};
loadingManager.onProgress = (_url, loaded, total) => {
  progressBar.style.transform =
    `scaleX(${Math.max(0.08, loaded / Math.max(total, 1))})`;
};
loadingManager.onLoad = () => {
  progressBar.style.transform = "scaleX(1)";
  delete progressBar.dataset.state;
};

const loader = new GLTSLoader(loadingManager, { isPreview: true });
const timer = new THREE.Timer();
timer.connect(document);
let current: LoadedScene | undefined;
let renderFailure: GLTSScene | undefined;
let disposed = false;
let dragDepth = 0;

function showStatus(message: string, state: "ready" | "busy" | "error"): void {
  status.textContent = message;
  statusDot.dataset.state = state;
}

function setCamera(scene?: GLTSScene, showcase?: Showcase): void {
  controls.dispose();
  camera = scene?.defaultCamera ?? fallbackCamera;
  if (camera === fallbackCamera) {
    fallbackCamera.position.set(4.6, 2.8, 5.8);
  }
  controls = createControls(camera);
  controls.target.fromArray(showcase?.target ?? [0, 0.8, 0]);
  controls.update();
  resize();
}

function setBusy(busy: boolean): void {
  fileInput.disabled = busy;
  showcaseButton.disabled = busy;
}

function selectButton(url?: string): void {
  showcaseButton.setAttribute(
    "aria-pressed",
    String(showcaseButton.dataset.showcase === url)
  );
}

function disposeScene(loaded: LoadedScene): void {
  try {
    gltsRenderer.release(loaded.scene);
  } finally {
    try {
      loaded.scene.dispose();
    } finally {
      if (loaded.objectURL) URL.revokeObjectURL(loaded.objectURL);
    }
  }
}

async function openScene(
  url: string,
  name: string,
  showcase?: Showcase,
  objectURL?: string
): Promise<void> {
  if (fileInput.disabled) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    return;
  }

  setBusy(true);
  showStatus(`Opening ${name}…`, "busy");
  let scene: GLTSScene;
  try {
    scene = await loader.loadAsync(url);
  } catch (error) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    showStatus(`Couldn’t open ${name}. ${errorMessage(error)}`, "error");
    setBusy(false);
    fileInput.value = "";
    return;
  }

  const previous = current;
  current = { objectURL, scene };
  renderFailure = undefined;
  setCamera(scene, showcase);
  selectButton(showcase?.url);
  viewer.dataset.state = "ready";
  showStatus(
    showcase ? `${showcase.label} · ${showcase.strength}` : `${name} · local file`,
    "ready"
  );
  if (previous) {
    try {
      disposeScene(previous);
    } catch (error) {
      console.error(error);
      showStatus(`Opened ${name}, but cleanup failed. ${errorMessage(error)}`, "error");
    }
  }
  setBusy(false);
  fileInput.value = "";
}

async function openFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith(".glts")) {
    showStatus("Choose a .glts file. The current scene is unchanged.", "error");
    return;
  }
  const url = URL.createObjectURL(file);
  await openScene(url, file.name, undefined, url);
}

function draggedFiles(event: DragEvent): FileList | undefined {
  return event.dataTransfer?.types.includes("Files")
    ? event.dataTransfer.files
    : undefined;
}

function showDropTarget(event: DragEvent): void {
  if (!draggedFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  viewer.dataset.dragging = "";
}

function keepDropTarget(event: DragEvent): void {
  if (!draggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function hideDropTarget(event: DragEvent): void {
  if (!draggedFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) delete viewer.dataset.dragging;
}

function dropFile(event: DragEvent): void {
  const files = draggedFiles(event);
  if (!files) return;
  event.preventDefault();
  dragDepth = 0;
  delete viewer.dataset.dragging;
  if (files.length !== 1) {
    showStatus("Drop one self-contained .glts file at a time.", "error");
    return;
  }
  const file = files.item(0);
  if (!file) {
    throw new Error("Dropped file is missing");
  }
  void openFile(file);
}

showcaseButton.addEventListener("click", () => {
  void openScene(showcase.url, showcase.label, showcase);
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});
window.addEventListener("dragenter", showDropTarget);
window.addEventListener("dragover", keepDropTarget);
window.addEventListener("dragleave", hideDropTarget);
window.addEventListener("drop", dropFile);

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  } else if (camera instanceof THREE.OrthographicCamera) {
    const center = (camera.left + camera.right) / 2;
    const halfWidth = (camera.top - camera.bottom) * width / height / 2;
    camera.left = center - halfWidth;
    camera.right = center + halfWidth;
    camera.updateProjectionMatrix();
  }
}

function disposeHost(): void {
  if (disposed) return;
  disposed = true;
  renderer.setAnimationLoop(null);
  window.removeEventListener("resize", resize);
  window.removeEventListener("dragenter", showDropTarget);
  window.removeEventListener("dragover", keepDropTarget);
  window.removeEventListener("dragleave", hideDropTarget);
  window.removeEventListener("drop", dropFile);
  controls.dispose();
  timer.dispose();
  if (current) disposeScene(current);
  gltsRenderer.dispose();
  loader.dispose();
  renderer.dispose();
}

window.addEventListener("beforeunload", disposeHost);
window.addEventListener("resize", resize);
resize();
setCamera();

let statsAt = 0;
renderer.setAnimationLoop(() => {
  timer.update();
  controls.update();
  const scene = current?.scene;
  const delta = timer.getDelta();
  if (scene && scene !== renderFailure) {
    renderer.info.reset();
    try {
      scene.update(delta);
      gltsRenderer.render(scene, camera, delta);
    } catch (error) {
      renderFailure = scene;
      console.error(error);
      showStatus(`Rendering failed. ${errorMessage(error)}`, "error");
    }
  }

  const elapsed = timer.getElapsed();
  if (scene && elapsed - statsAt > 0.5) {
    statsAt = elapsed;
    stats.textContent =
      `${renderer.info.render.triangles.toLocaleString()} triangles · ` +
      `${renderer.info.render.calls} draw calls`;
  }
});

void openScene(showcase.url, showcase.label, showcase);
