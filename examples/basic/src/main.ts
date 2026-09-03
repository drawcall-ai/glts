import { GLTSLoader, type GLTSScene } from "@drawcall/glts";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import "./style.css";

interface ElementConstructor<T extends Element> {
  new (): T;
}

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

function canvasContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas context is unavailable");
  }

  return context;
}

const HAZE = "#b8815a";
const SUN_DIRECTION = new THREE.Vector3(-0.66, 0.42, -0.62).normalize();
const compactViewport = window.matchMedia("(max-width: 860px)");
const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * One equirectangular canvas drives the background, the image-based lighting,
 * and the position of the visible sun, so the key light always agrees with the
 * sky behind it.
 */
function createSkyTexture(): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const context = canvasContext(width, height);

  const sky = context.createLinearGradient(0, 0, 0, height / 2);
  sky.addColorStop(0, "#0b1120");
  sky.addColorStop(0.42, "#2c3a5c");
  sky.addColorStop(0.76, "#7d6c78");
  sky.addColorStop(1, HAZE);
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height / 2);

  const ground = context.createLinearGradient(0, height / 2, 0, height);
  ground.addColorStop(0, HAZE);
  ground.addColorStop(1, "#1d1712");
  context.fillStyle = ground;
  context.fillRect(0, height / 2, width, height / 2);

  const x = (Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x) / (Math.PI * 2) + 0.5) * width;
  const y = (0.5 - Math.asin(SUN_DIRECTION.y) / Math.PI) * height;
  context.globalCompositeOperation = "lighter";
  const glow = context.createRadialGradient(x, y, 0, x, y, height * 0.62);
  glow.addColorStop(0, "rgba(255, 226, 182, 1)");
  glow.addColorStop(0.06, "rgba(255, 197, 133, 0.72)");
  glow.addColorStop(0.34, "rgba(196, 118, 84, 0.24)");
  glow.addColorStop(1, "rgba(120, 70, 60, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(context.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

function createGroundTexture(): THREE.CanvasTexture {
  const size = 512;
  const context = canvasContext(size, size);
  context.fillStyle = "#4c3d2d";
  context.fillRect(0, 0, size, size);

  for (let blob = 0; blob < 320; blob += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const radius = 6 + Math.random() * 46;
    const tone = Math.round(46 + Math.random() * 76);
    context.fillStyle = `rgba(${tone}, ${Math.round(tone * 0.82)}, ${Math.round(tone * 0.6)}, 0.3)`;
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        context.beginPath();
        context.arc(x + dx, y + dy, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  const texture = new THREE.CanvasTexture(context.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(16, 16);
  return texture;
}

const canvas = requiredElement("#scene", HTMLCanvasElement);
const status = requiredElement("#status", HTMLElement);
const statusDot = requiredElement("#status-dot", HTMLElement);
const graph = requiredElement("#graph", HTMLElement);
const stats = requiredElement("#stats", HTMLElement);
const progressBar = requiredElement("#progress-bar", HTMLElement);
const reloadTree = requiredElement("#reload-tree", HTMLButtonElement);
const reloadBranch = requiredElement("#reload-branch", HTMLButtonElement);

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
const sky = createSkyTexture();
scene.background = sky;
scene.environment = sky;
scene.environmentIntensity = 0.95;
scene.fog = new THREE.FogExp2(HAZE, 0.019);

const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 240);
camera.position.set(10.6, 3.6, 12.2);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(-0.9, 3.4, 0);
controls.minDistance = 5;
controls.maxDistance = 40;
controls.maxPolarAngle = Math.PI * 0.495;
controls.autoRotateSpeed = 0.32;
let orbitEngaged = false;
function updateAutoRotate(): void {
  controls.autoRotate = !stillness.matches && !orbitEngaged;
}
updateAutoRotate();
controls.addEventListener("start", () => {
  orbitEngaged = true;
  updateAutoRotate();
});
stillness.addEventListener("change", updateAutoRotate);

const sun = new THREE.DirectionalLight("#ffd2a1", 3.4);
sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
sun.target.position.set(0, 2.4, 0);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(compactViewport.matches ? 1024 : 2048);
sun.shadow.camera.near = 6;
sun.shadow.camera.far = 40;
sun.shadow.camera.left = -9;
sun.shadow.camera.right = 9;
sun.shadow.camera.top = 9;
sun.shadow.camera.bottom = -9;
sun.shadow.bias = -0.0009;
sun.shadow.normalBias = 0.018;
// Cool sky bounce so the backlit trunk keeps its bark rather than going flat.
const bounce = new THREE.DirectionalLight("#8fb6e8", 0.7);
bounce.position.set(7, 4, 8);
scene.add(sun, sun.target, bounce);

const groundTexture = createGroundTexture();
groundTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(70, 96),
  new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const loadingManager = new THREE.LoadingManager();
loadingManager.onStart = () => {
  progressBar.dataset.state = "active";
  progressBar.style.width = "8%";
};
loadingManager.onProgress = (_url, loaded, total) => {
  progressBar.style.width = `${Math.max(8, (loaded / Math.max(total, 1)) * 100)}%`;
};
loadingManager.onLoad = () => {
  progressBar.style.width = "100%";
  delete progressBar.dataset.state;
};

const loader = new GLTSLoader(loadingManager);
const timer = new THREE.Timer();
timer.connect(document);
let loadedTree: GLTSScene | undefined;
let disposed = false;

function disposeHost(): void {
  if (disposed) {
    return;
  }
  disposed = true;

  const errors: unknown[] = [];
  const cleanups = [
    () => renderer.setAnimationLoop(null),
    () => window.removeEventListener("resize", resize),
    () => stillness.removeEventListener("change", updateAutoRotate),
    () => controls.dispose(),
    () => timer.dispose(),
    () => loadedTree?.dispose(),
    () => loader.dispose(),
    () => sky.dispose(),
    () => groundTexture.dispose(),
    () => ground.geometry.dispose(),
    () => ground.material.dispose(),
    () => renderer.dispose()
  ];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Example cleanup failed");
  }
}

window.addEventListener("beforeunload", disposeHost);

// The result is an ordinary THREE.Group with url/update/reload/dispose, so it
// goes straight into the scene graph.
try {
  loadedTree = await loader.loadAsync("/assets/tree.glts");
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  statusDot.dataset.state = "error";
  try {
    disposeHost();
  } catch (cleanup) {
    throw new AggregateError([error, cleanup], "Initial load and cleanup failed");
  }
  throw error;
}
const tree = loadedTree;
scene.add(tree);

/** Walks the loaded group and reports the managed GLTS nodes it actually contains. */
function describeGraph(): void {
  graph.replaceChildren();
  const rows: readonly [string, string][] = [["root", tree.url]];
  const nested: [string, string][] = [];
  tree.traverse((object) => {
    if (object === tree || !("url" in object) || typeof object.url !== "string") {
      return;
    }

    const kind = "count" in object && typeof object.count === "number"
      ? `instanced ×${object.count}`
      : "nested";
    nested.push([kind, object.url]);
  });

  for (const [kind, url] of [...rows, ...nested]) {
    const item = document.createElement("li");
    const label = document.createElement("b");
    label.textContent = kind;
    const value = document.createElement("em");
    value.textContent = new URL(url).pathname;
    item.append(label, value);
    graph.append(item);
  }
}

function showStatus(message: string, state: "ready" | "busy" | "error"): void {
  status.textContent = message;
  statusDot.dataset.state = state;
}

async function reload(url: string): Promise<void> {
  showStatus(`Reloading ${url}…`, "busy");
  reloadTree.disabled = true;
  reloadBranch.disabled = true;

  try {
    // The root node reloads itself; a nested URL reloads every live node that
    // was loaded from it — here both the bough and the instanced crown.
    if (url === "/assets/tree.glts") {
      await tree.reload();
    } else {
      await loader.reload(url);
    }
    describeGraph();
    showStatus(`Reloaded ${url}`, "ready");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    reloadTree.disabled = false;
    reloadBranch.disabled = false;
  }
}

reloadTree.addEventListener("click", () => void reload("/assets/tree.glts"));
reloadBranch.addEventListener("click", () => void reload("/assets/branch.glts"));

describeGraph();
showStatus("Asset loaded", "ready");

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
resize();

let statsAt = 0;

renderer.setAnimationLoop(() => {
  timer.update();
  if (!stillness.matches) {
    tree.update(timer.getDelta());
  }
  controls.update();
  renderer.render(scene, camera);

  const elapsed = timer.getElapsed();
  if (elapsed - statsAt > 0.5) {
    statsAt = elapsed;
    stats.textContent = `${renderer.info.render.triangles.toLocaleString()} triangles · ${renderer.info.render.calls} draw calls`;
  }
});
