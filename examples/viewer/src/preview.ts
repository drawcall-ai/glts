import { GLTSRenderer, type GLTSScene } from "@drawcall/glts";
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export async function createPreview(
  canvas: HTMLCanvasElement,
  onError: (error: unknown) => void,
  onStats: (text: string) => void
) {
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    canvas
  });
  renderer.onDeviceLost = (info) => onError(new Error(info.message));
  await renderer.init();
  const gltsRenderer = new GLTSRenderer(renderer);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

  const timer = new THREE.Timer();
  timer.connect(document);
  let current: GLTSScene | undefined;
  let renderFailure: GLTSScene | undefined;

  function setCamera(
    scene?: GLTSScene,
    target: readonly [number, number, number] = [0, 0.8, 0]
  ): void {
    controls.dispose();
    camera = scene?.defaultCamera ?? fallbackCamera;
    if (camera === fallbackCamera) {
      fallbackCamera.position.set(4.6, 2.8, 5.8);
    }
    controls = createControls(camera);
    controls.target.fromArray(target);
    controls.update();
    resize();
  }

  function resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
  }

  window.addEventListener("resize", resize);
  resize();
  setCamera();

  let statsAt = 0;
  renderer.setAnimationLoop(() => {
    timer.update();
    controls.update();
    const scene = current;
    const delta = timer.getDelta();
    if (scene && scene !== renderFailure) {
      renderer.info.reset();
      try {
        scene.update(delta);
        gltsRenderer.render(scene, camera);
      } catch (error) {
        renderFailure = scene;
        onError(error);
      }
    }

    const elapsed = timer.getElapsed();
    if (scene && elapsed - statsAt > 0.5) {
      statsAt = elapsed;
      onStats(
        `${renderer.info.render.triangles.toLocaleString()} triangles · ` +
        `${renderer.info.render.drawCalls} draw calls`
      );
    }
  });

  return {
    setScene(scene: GLTSScene, target?: readonly [number, number, number]): void {
      current = scene;
      renderFailure = undefined;
      setCamera(scene, target);
    }
  };
}
