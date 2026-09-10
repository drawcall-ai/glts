import { GLTSLoader, GLTSUSDExporter } from "@drawcall/glts";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RigidBody } from "@drawcall/physics";
import { setupWorld } from "@drawcall/physics-rapier";

const canvas = document.querySelector("canvas");
const status = document.querySelector("output");
const reset = document.querySelector("#reset");
const exportButton = document.querySelector("#export");
if (
  !canvas ||
  !status ||
  !(reset instanceof HTMLButtonElement) ||
  !(exportButton instanceof HTMLButtonElement)
) {
  throw new Error("Missing example controls.");
}

async function start(
  canvas: HTMLCanvasElement,
  status: HTMLOutputElement,
  reset: HTMLButtonElement,
  exportButton: HTMLButtonElement,
) {
  const world = await setupWorld();
  const loader = new GLTSLoader(new THREE.LoadingManager());
  const assembly = await loader.loadAsync("/ragdoll.glts");
  const pelvis = assembly.getObjectByName("Pelvis");
  if (!(pelvis instanceof RigidBody)) throw new Error("Missing ragdoll pelvis");
  const scene = new THREE.Scene();
  scene.add(assembly, new THREE.HemisphereLight(0xffffff, 0x667788, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 5, 4);
  scene.add(light, new THREE.GridHelper(10, 20));
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(4, 3, 5);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x18212c);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();
  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  resize();
  window.addEventListener("resize", resize);
  reset.disabled = false;
  reset.addEventListener("click", () => world.reset());
  let exporting = false;
  exportButton.disabled = false;
  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    exporting = true;
    try {
      world.reset();
      const bytes = await new GLTSUSDExporter().parseAsync(assembly);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "model/vnd.usdz+zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "ragdoll.usdz";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      status.textContent = String(error);
      console.error(error);
    } finally {
      exporting = false;
      exportButton.disabled = false;
    }
  });
  const timer = new THREE.Timer();
  timer.connect(document);
  renderer.setAnimationLoop(() => {
    try {
      timer.update();
      if (!exporting) world.update(timer.getDelta());
      status.textContent = `Pelvis height: ${pelvis.position.y.toFixed(2)} m`;
      renderer.render(scene, camera);
    } catch (error) {
      renderer.setAnimationLoop(null);
      status.textContent = String(error);
      console.error(error);
    }
  });
  window.addEventListener(
    "pagehide",
    () => {
      renderer.setAnimationLoop(null);
      window.removeEventListener("resize", resize);
      const errors: unknown[] = [];
      for (const resource of [loader, world, controls, timer, renderer]) {
        try {
          resource.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "Physics example disposal failed");
    },
    { once: true },
  );
}

start(canvas, status, reset, exportButton).catch((error: unknown) => {
  status.textContent = String(error);
  console.error(error);
});
