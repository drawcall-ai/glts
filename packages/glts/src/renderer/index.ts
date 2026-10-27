import * as THREE from "three/webgpu";

import { assertUndisposed } from "../node.js";
import type { GLTSScene } from "../types.js";
import { Effects } from "./effects.js";

const claimedRenderers = new WeakSet<THREE.WebGPURenderer>();

export class GLTSRenderer {
  readonly #effects: Effects;
  readonly #renderer: THREE.WebGPURenderer;
  readonly #size = new THREE.Vector2();
  readonly #viewport = new THREE.Vector4();
  readonly #scissor = new THREE.Vector4();
  #state: THREE.RendererUtils.RendererState | undefined;
  #disposed = false;
  #busy = false;

  /** The host must await renderer.init() before creating its GLTSRenderer. */
  constructor(renderer: THREE.WebGPURenderer) {
    if (!renderer.initialized) {
      throw new Error("GLTSRenderer requires an initialized WebGPURenderer; await renderer.init() first");
    }
    if (renderer.coordinateSystem !== THREE.WebGPUCoordinateSystem) {
      throw new Error("GLTSRenderer requires a WebGPU backend");
    }
    if (claimedRenderers.has(renderer)) {
      throw new Error("A WebGPURenderer can have only one active GLTSRenderer");
    }
    claimedRenderers.add(renderer);
    this.#renderer = renderer;
    this.#effects = new Effects(renderer);
  }

  /**
   * Renders with `camera`, or scene.defaultCamera, applying the scene's rendering profile and effects only
   * for this render. Sizes camera projection to the active viewport, preserving orthographic height and zoom.
   */
  render(scene: GLTSScene, camera?: THREE.Camera): void {
    if (this.#disposed) throw new Error("GLTSRenderer has been disposed");
    if (this.#busy) throw new Error("GLTSRenderer cannot render recursively");
    assertUndisposed(scene);
    const selectedCamera = camera === undefined ? scene.defaultCamera : camera;
    if (selectedCamera?.isCamera !== true) {
      throw new TypeError("GLTSRenderer.render() requires a camera or scene.defaultCamera");
    }
    this.#assertFullFramebuffer(scene);
    this.#resizeCamera(selectedCamera);

    const renderer = this.#renderer;
    const state = THREE.RendererUtils.saveRendererState(renderer, this.#state);
    this.#state = state;
    renderer.getViewport(this.#viewport);
    renderer.getScissor(this.#scissor);
    const shadows = renderer.shadowMap.enabled;
    const xr = renderer.xr.enabled;
    const transparent = renderer.transparent;
    const opaque = renderer.opaque;
    const contextNode = renderer.contextNode;
    const name = scene.name;
    const overrideMaterial = scene.overrideMaterial;
    const layers = selectedCamera.layers.mask;
    this.#busy = true;
    try {
      // Factories observe host state before the profile is applied.
      const pipeline = this.#effects.prepare(scene, selectedCamera);
      renderer.shadowMap.enabled = scene.rendering.shadows;
      renderer.toneMapping = scene.rendering.toneMapping;
      renderer.toneMappingExposure = scene.rendering.toneMappingExposure;
      if (pipeline) pipeline.render();
      else renderer.render(scene, selectedCamera);
    } finally {
      // Three's render pipeline and effect nodes restore their state only after a successful render.
      THREE.RendererUtils.restoreRendererState(renderer, state);
      renderer.setViewport(this.#viewport);
      renderer.setScissor(this.#scissor);
      renderer.shadowMap.enabled = shadows;
      renderer.xr.enabled = xr;
      renderer.transparent = transparent;
      renderer.opaque = opaque;
      renderer.contextNode = contextNode;
      scene.name = name;
      scene.overrideMaterial = overrideMaterial;
      selectedCamera.layers.mask = layers;
      this.#busy = false;
    }
  }

  #resizeCamera(camera: THREE.Camera): void {
    if (!(camera instanceof THREE.PerspectiveCamera) && !(camera instanceof THREE.OrthographicCamera)) return;
    const renderer = this.#renderer;
    const viewport = renderer.getRenderTarget()?.viewport ?? renderer.getViewport(this.#viewport);
    if (
      !Number.isFinite(viewport.z) || !Number.isFinite(viewport.w) ||
      viewport.z <= 0 || viewport.w <= 0
    ) {
      throw new RangeError("GLTS camera projection requires a positive finite viewport size");
    }
    const aspect = viewport.z / viewport.w;
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect;
    else {
      const center = (camera.left + camera.right) / 2;
      const halfWidth = (camera.top - camera.bottom) * aspect / 2;
      camera.left = center - halfWidth;
      camera.right = center + halfWidth;
    }
    camera.updateProjectionMatrix();
  }

  #assertFullFramebuffer(scene: GLTSScene): void {
    if (scene.rendering.effects.length === 0) return;
    const renderer = this.#renderer;
    if (renderer.getRenderTarget()) throw new Error("GLTS effects require the default framebuffer");
    const size = renderer.getSize(this.#size);
    const viewport = renderer.getViewport(this.#viewport);
    if (
      renderer.getScissorTest() || viewport.x !== 0 || viewport.y !== 0 ||
      viewport.z !== size.width || viewport.w !== size.height
    ) {
      throw new Error("GLTS effects require a full viewport with scissor testing disabled");
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#state = undefined;
    claimedRenderers.delete(this.#renderer);
    this.#effects.dispose();
  }
}
