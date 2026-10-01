import { GLTSLoader, GLTSRenderer, type GLTSScene } from "@drawcall/glts";
import * as THREE from "three";

// Frame callbacks run once with this step before the render, so they can
// apply authored state such as animation poses. Physics is never simulated.
const delta = 1 / 60;

let failed = false;

addEventListener("error", (event) =>
  fail(event.error ?? new Error(event.message || "The preview failed.")),
);
addEventListener("unhandledrejection", (event) => fail(event.reason));
render().then(() => {
  if (!failed) console.log("ready");
}, fail);

async function render(): Promise<void> {
  const url = new URLSearchParams(location.search).get("url");
  if (!url) throw new Error("Missing the asset URL: open this page with ?url=<asset.glts>.");

  const renderer = new THREE.WebGLRenderer({
    ...GLTSRenderer.parameters,
    antialias: true,
    // Keeps the frame readable by screenshots after it was drawn.
    preserveDrawingBuffer: true,
  });
  renderer.domElement.addEventListener("webglcontextlost", () =>
    fail(new Error("The WebGL context was lost.")),
  );
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setClearColor(0x111111);
  document.body.append(renderer.domElement);

  const loader = new GLTSLoader(new THREE.LoadingManager(), { isPreview: true });
  const scene = await loader.loadAsync(new URL(url, location.href));
  scene.updateWorldMatrix(true, true);
  scene.update(delta);

  const camera = previewCamera(scene, innerWidth / innerHeight);
  new GLTSRenderer(renderer).render(scene, camera, delta);
}

function previewCamera(scene: GLTSScene, aspect: number): THREE.Camera {
  const camera = scene.defaultCamera ?? fitCamera(scene);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  return camera;
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

function fail(error: unknown): void {
  if (failed) return;
  failed = true;
  console.error(error);
  const output = document.createElement("pre");
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
