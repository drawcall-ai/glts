import { GLTSLoader, type GLTSScene } from "@drawcall/glts";
import "@fontsource-variable/newsreader";
import { LoadingManager } from "three";
import { createPreview } from "./preview.js";
import { bindFileDrop } from "./file-drop.js";

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

const preview = createPreview(canvas, (error) => {
  console.error(error);
  showStatus(`Rendering failed. ${errorMessage(error)}`, "error");
}, (text) => { stats.textContent = text; });

const loadingManager = new LoadingManager();
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
let current: LoadedScene | undefined;
let disposed = false;

function showStatus(message: string, state: "ready" | "busy" | "error"): void {
  status.textContent = message;
  statusDot.dataset.state = state;
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
    preview.release(loaded.scene);
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
  preview.setScene(scene, showcase?.target);
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

showcaseButton.addEventListener("click", () => {
  void openScene(showcase.url, showcase.label, showcase);
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});
const unbindFileDrop = bindFileDrop(
  viewer,
  (file) => { void openFile(file); },
  (message) => showStatus(message, "error")
);

function disposeHost(): void {
  if (disposed) return;
  disposed = true;
  unbindFileDrop();
  const errors: unknown[] = [];
  for (const dispose of [
    () => { if (current) disposeScene(current); },
    () => preview.dispose(),
    () => loader.dispose()
  ]) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Viewer disposal failed");
}

window.addEventListener("beforeunload", disposeHost);
void openScene(showcase.url, showcase.label, showcase);
