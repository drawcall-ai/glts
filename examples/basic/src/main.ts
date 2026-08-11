import { GLTSLoader } from "@drawcall/glts";
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

const canvas = requiredElement("#scene", HTMLCanvasElement);
const status = requiredElement("#status", HTMLElement);
const statusDot = requiredElement("#status-dot", HTMLElement);
const reloadTree = requiredElement("#reload-tree", HTMLButtonElement);
const reloadBranch = requiredElement("#reload-branch", HTMLButtonElement);

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#dce5d3");
scene.fog = new THREE.Fog("#dce5d3", 10, 24);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(7, 4.8, 9);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 2.3, 0);
controls.maxPolarAngle = Math.PI * 0.49;

const hemisphere = new THREE.HemisphereLight("#f4ffe8", "#604b37", 2.8);
scene.add(hemisphere);

const sun = new THREE.DirectionalLight("#fff7db", 4.5);
sun.position.set(5, 9, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(7, 64),
  new THREE.MeshStandardMaterial({ color: "#83956f", roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const loader = new GLTSLoader();
const asset = await loader.loadAsync("/assets/tree.glts");
asset.scene.name = "Stable tree wrapper";
scene.add(asset.scene);

function showStatus(message: string, state: "ready" | "busy" | "error"): void {
  status.textContent = message;
  statusDot.dataset.state = state;
}

async function reload(url: string): Promise<void> {
  showStatus(`Reloading ${url}…`, "busy");
  reloadTree.disabled = true;
  reloadBranch.disabled = true;

  try {
    await loader.reload(url);
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

showStatus("Asset loaded", "ready");

function resize(): void {
  const parent = canvas.parentElement;
  if (!parent) {
    return;
  }

  const width = parent.clientWidth;
  const height = parent.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

const resizeObserver = new ResizeObserver(resize);
if (canvas.parentElement) {
  resizeObserver.observe(canvas.parentElement);
}
resize();

const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const elapsed = timer.getElapsed();
  asset.scene.rotation.y = Math.sin(elapsed * 0.22) * 0.08;
  controls.update();
  renderer.render(scene, camera);
});

window.addEventListener("beforeunload", () => {
  resizeObserver.disconnect();
  controls.dispose();
  timer.dispose();
  asset.dispose();
  loader.dispose();
  renderer.dispose();
  ground.geometry.dispose();
  ground.material.dispose();
});
