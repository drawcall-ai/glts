import * as THREE from "three";

import { assertDelta, assertUndisposed } from "../node.js";
import type { GLTSScene } from "../types.js";
import { Effects } from "./effects.js";

const claimedRenderers = new WeakSet<THREE.WebGLRenderer>();

function markMaterialsForUpdate(scene: THREE.Scene): void {
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      material.needsUpdate = true;
    }
  });
}

export class GLTSRenderer {
  static readonly parameters = Object.freeze({
    outputBufferType: THREE.HalfFloatType
  }) satisfies THREE.WebGLRendererParameters;

  readonly #effects: Effects;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #size = new THREE.Vector2();
  readonly #viewport = new THREE.Vector4();
  #disposed = false;
  #busy = false;

  constructor(renderer: THREE.WebGLRenderer) {
    if (claimedRenderers.has(renderer)) {
      throw new Error("A WebGLRenderer can have only one active GLTSRenderer");
    }
    claimedRenderers.add(renderer);
    this.#renderer = renderer;
    this.#effects = new Effects(renderer);
  }

  /**
   * Renders `scene` with `camera`, or its defaultCamera, applying its rendering profile and effects only for this
   * render; `delta` advances the effects. Sizes camera projection to the active viewport, preserving orthographic
   * height and zoom.
   */
  render(scene: GLTSScene, camera?: THREE.Camera, delta = 0): void {
    if (this.#disposed) {
      throw new Error("GLTSRenderer has been disposed");
    }
    if (this.#busy) {
      throw new Error("GLTSRenderer cannot render recursively");
    }
    assertUndisposed(scene);
    assertDelta(delta);
    const selectedCamera = camera === undefined ? scene.defaultCamera : camera;
    if (selectedCamera?.isCamera !== true) {
      throw new TypeError(
        "GLTSRenderer.render() requires a camera or scene.defaultCamera"
      );
    }
    const renderer = this.#renderer;
    const profile = scene.rendering;
    const renderTarget = renderer.getRenderTarget();
    this.#assertFullFramebuffer(scene);
    this.#resizeCamera(selectedCamera);

    const localClippingEnabled = renderer.localClippingEnabled;
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const shadows = renderer.shadowMap.enabled;
    const toneMapping = renderer.toneMapping;
    const toneMappingExposure = renderer.toneMappingExposure;
    const shadowsChanged = shadows !== profile.shadows;
    this.#busy = true;
    try {
      // Factories observe host state before the profile is applied.
      const passes = this.#effects.prepare(scene, selectedCamera);
      renderer.localClippingEnabled = profile.localClippingEnabled;
      renderer.shadowMap.enabled = profile.shadows;
      renderer.toneMapping = profile.toneMapping;
      renderer.toneMappingExposure = profile.toneMappingExposure;
      if (shadowsChanged) markMaterialsForUpdate(scene);
      this.#effects.render(scene, selectedCamera, passes, delta);
    } finally {
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.localClippingEnabled = localClippingEnabled;
      renderer.shadowMap.enabled = shadows;
      renderer.toneMapping = toneMapping;
      renderer.toneMappingExposure = toneMappingExposure;
      if (shadowsChanged) markMaterialsForUpdate(scene);
      this.#busy = false;
    }
  }

  #resizeCamera(camera: THREE.Camera): void {
    if (!(camera instanceof THREE.PerspectiveCamera) && !(camera instanceof THREE.OrthographicCamera)) {
      return;
    }
    const renderer = this.#renderer;
    const viewport = renderer.getRenderTarget()
      ? renderer.getCurrentViewport(this.#viewport)
      : renderer.getViewport(this.#viewport);
    if (
      !Number.isFinite(viewport.z) || !Number.isFinite(viewport.w) ||
      viewport.z <= 0 || viewport.w <= 0
    ) {
      throw new RangeError("GLTS camera projection requires a positive finite viewport size");
    }
    const aspect = viewport.z / viewport.w;
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = aspect;
    } else {
      const center = (camera.left + camera.right) / 2;
      const halfWidth = (camera.top - camera.bottom) * aspect / 2;
      camera.left = center - halfWidth;
      camera.right = center + halfWidth;
    }
    camera.updateProjectionMatrix();
  }

  /** Throws unless effects and tone mapping, which composite the whole canvas, can render `scene`. */
  #assertFullFramebuffer(scene: GLTSScene): void {
    const { effects, toneMapping } = scene.rendering;
    if (effects.length === 0 && toneMapping === THREE.NoToneMapping) return;
    const renderer = this.#renderer;
    if (renderer.getRenderTarget()) {
      throw new Error("GLTS effects and tone mapping require the default WebGL framebuffer");
    }
    const size = renderer.getSize(this.#size);
    const viewport = renderer.getViewport(this.#viewport);
    if (
      renderer.getScissorTest() ||
      viewport.x !== 0 ||
      viewport.y !== 0 ||
      viewport.z !== size.width ||
      viewport.w !== size.height
    ) {
      throw new Error("GLTS effects and tone mapping require a full viewport with scissor testing disabled");
    }
    // A previous render target can leave Three's current viewport stale.
    renderer.setViewport(viewport);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    claimedRenderers.delete(this.#renderer);
    this.#effects.dispose();
  }
}
