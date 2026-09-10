import * as THREE from "three";

import type { GLTSScene } from "../types.js";
import { Effects } from "./effects.js";

const claimedRenderers = new WeakSet<THREE.WebGLRenderer>();

function invalidateMaterials(scene: THREE.Scene): void {
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
  #rendering = false;

  constructor(renderer: THREE.WebGLRenderer) {
    if (claimedRenderers.has(renderer)) {
      throw new Error("A WebGLRenderer can have only one active GLTSRenderer");
    }
    claimedRenderers.add(renderer);
    this.#renderer = renderer;
    this.#effects = new Effects(renderer);
  }

  render(scene: GLTSScene, camera?: THREE.Camera, delta = 0): void {
    if (this.#disposed) {
      throw new Error("GLTSRenderer has been disposed");
    }
    if (this.#rendering) {
      throw new Error("GLTSRenderer cannot render recursively");
    }
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError("GLTS render delta must be a non-negative finite number");
    }
    const selectedCamera = camera === undefined ? scene.defaultCamera : camera;
    if (selectedCamera?.isCamera !== true) {
      throw new TypeError(
        "GLTSRenderer.render() requires a camera or scene.defaultCamera"
      );
    }
    const renderer = this.#renderer;
    const rendering = scene.rendering;
    const renderTarget = this.#prepareFramebuffer(scene);

    const localClippingEnabled = renderer.localClippingEnabled;
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const shadows = renderer.shadowMap.enabled;
    const toneMapping = renderer.toneMapping;
    const toneMappingExposure = renderer.toneMappingExposure;
    const shadowChange = shadows !== rendering.shadows;
    this.#rendering = true;
    try {
      this.#effects.render(scene, selectedCamera, delta, () => {
        renderer.localClippingEnabled = rendering.localClippingEnabled;
        renderer.shadowMap.enabled = rendering.shadows;
        renderer.toneMapping = rendering.toneMapping;
        renderer.toneMappingExposure = rendering.toneMappingExposure;
        if (shadowChange) invalidateMaterials(scene);
      });
    } finally {
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.localClippingEnabled = localClippingEnabled;
      renderer.shadowMap.enabled = shadows;
      renderer.toneMapping = toneMapping;
      renderer.toneMappingExposure = toneMappingExposure;
      if (shadowChange) invalidateMaterials(scene);
      this.#rendering = false;
    }
  }

  #prepareFramebuffer(scene: GLTSScene) {
    const renderer = this.#renderer;
    const rendering = scene.rendering;
    const renderTarget = renderer.getRenderTarget();
    const needsOutput =
      rendering.effects.length > 0 ||
      rendering.toneMapping !== THREE.NoToneMapping;
    if (renderTarget && needsOutput) {
      throw new Error(
        "GLTS effects and tone mapping require the default WebGL framebuffer"
      );
    }
    if (needsOutput) {
      const size = renderer.getSize(this.#size);
      const viewport = renderer.getViewport(this.#viewport);
      if (
        renderer.getScissorTest() ||
        viewport.x !== 0 ||
        viewport.y !== 0 ||
        viewport.z !== size.width ||
        viewport.w !== size.height
      ) {
        throw new Error(
          "GLTS effects and tone mapping require a full viewport with scissor testing disabled"
        );
      }
      // A previous render target can leave Three's current viewport stale.
      renderer.setViewport(viewport);
    }

    return renderTarget;
  }

  release(scene: GLTSScene): void {
    this.#effects.release(scene);
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
