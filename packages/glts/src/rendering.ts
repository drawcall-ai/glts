import * as THREE from "three";
import type { Pass } from "three/addons/postprocessing/Pass.js";

import type { GLTSScene } from "./types.js";

export type GLTSScriptScene = Omit<THREE.Scene, "clone"> & {
  clone(recursive?: boolean): THREE.Scene;
  defaultCamera: THREE.Camera | undefined;
  readonly rendering: GLTSRenderingProfile;
};

export interface GLTSEffectContext {
  readonly camera: THREE.Camera;
  readonly height: number;
  readonly scene: GLTSScriptScene;
  readonly width: number;
}

export type GLTSEffect = (context: GLTSEffectContext) => Pass;

export interface GLTSRenderingProfile {
  effects: GLTSEffect[];
  localClippingEnabled: boolean;
  shadows: boolean;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
}

interface Effects {
  readonly camera: THREE.Camera;
  readonly factories: readonly GLTSEffect[];
  readonly source: GLTSEffect[];
  readonly passes: Pass[];
}

const claimedRenderers = new WeakSet<THREE.WebGLRenderer>();

export function createScene(): GLTSScriptScene {
  return Object.assign(new THREE.Scene(), {
    defaultCamera: undefined,
    rendering: {
      effects: [],
      localClippingEnabled: false,
      shadows: false,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1
    }
  });
}

function disposePasses(passes: readonly Pass[]): void {
  const errors: unknown[] = [];
  for (const pass of passes) {
    try {
      pass.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "GLTS effects disposal failed");
  }
}

function disposeAfterFailure(passes: readonly Pass[], error: unknown): never {
  try {
    disposePasses(passes);
  } catch (cleanup) {
    throw new AggregateError([error, cleanup], "GLTS effects creation and cleanup failed");
  }
  throw error;
}

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

  readonly #effects = new Map<GLTSScene, Effects>();
  readonly #renderer: THREE.WebGLRenderer;
  readonly #size = new THREE.Vector2();
  readonly #viewport = new THREE.Vector4();
  #disposed = false;
  #effectError: unknown;
  #effectFailed = false;
  #effectsSupported = false;
  #delta = 0;
  #rendering = false;

  constructor(renderer: THREE.WebGLRenderer) {
    if (claimedRenderers.has(renderer)) {
      throw new Error("A WebGLRenderer can have only one active GLTSRenderer");
    }
    claimedRenderers.add(renderer);
    this.#renderer = renderer;
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

    const localClippingEnabled = renderer.localClippingEnabled;
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const shadows = renderer.shadowMap.enabled;
    const toneMapping = renderer.toneMapping;
    const toneMappingExposure = renderer.toneMappingExposure;
    const shadowChange = shadows !== rendering.shadows;
    let effectsInstalled = false;

    this.#delta = delta;
    this.#effectError = undefined;
    this.#effectFailed = false;
    this.#rendering = true;
    try {
      const effects = this.#getEffects(scene, selectedCamera);
      renderer.localClippingEnabled = rendering.localClippingEnabled;
      renderer.shadowMap.enabled = rendering.shadows;
      renderer.toneMapping = rendering.toneMapping;
      renderer.toneMappingExposure = rendering.toneMappingExposure;
      if (shadowChange) invalidateMaterials(scene);
      if (effects.length > 0) {
        effectsInstalled = true;
        renderer.setEffects(effects);
        if (!this.#effectsSupported) {
          effectsInstalled = false;
          this.#effects.delete(scene);
          disposeAfterFailure(
            effects,
            new Error(
              "GLTS effects require a WebGLRenderer constructed with GLTSRenderer.parameters"
            )
          );
        }
      }
      renderer.render(scene, selectedCamera);
      if (this.#effectFailed) {
        throw this.#effectError;
      }
    } finally {
      if (effectsInstalled) renderer.setEffects(null);
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.localClippingEnabled = localClippingEnabled;
      renderer.shadowMap.enabled = shadows;
      renderer.toneMapping = toneMapping;
      renderer.toneMappingExposure = toneMappingExposure;
      if (shadowChange) invalidateMaterials(scene);
      this.#rendering = false;
    }
  }

  release(scene: GLTSScene): void {
    const effects = this.#effects.get(scene);
    if (!effects) {
      return;
    }
    this.#effects.delete(scene);
    disposePasses(effects.passes);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    claimedRenderers.delete(this.#renderer);
    const passes = [...this.#effects.values()].flatMap((effects) => effects.passes);
    this.#effects.clear();
    disposePasses(passes);
  }

  #getEffects(scene: GLTSScene, camera: THREE.Camera): Pass[] {
    const factories = scene.rendering.effects;
    const current = this.#effects.get(scene);
    if (factories.length === 0) {
      this.release(scene);
      return [];
    }
    if (
      current &&
      current.camera === camera &&
      current.source === factories &&
      current.factories.length === factories.length &&
      current.factories.every((factory, index) => factory === factories[index])
    ) {
      return current.passes;
    }

    if (current) {
      this.#effects.delete(scene);
      disposePasses(current.passes);
    }

    const size = this.#renderer.getDrawingBufferSize(this.#size);
    const passes: Pass[] = [];
    try {
      for (const factory of factories) {
        const pass = factory({
          camera,
          height: size.height,
          scene,
          width: size.width
        });
        if (
          !pass ||
          pass.isPass !== true ||
          typeof pass.render !== "function" ||
          typeof pass.setSize !== "function" ||
          typeof pass.dispose !== "function"
        ) {
          throw new TypeError("GLTS effect factories must return a Three.js Pass");
        }
        passes.push(pass);
        if (Reflect.get(pass, "isRenderPass") === true) {
          throw new TypeError(
            "GLTS effects must not include RenderPass; " +
            "GLTSRenderer renders the selected scene and camera"
          );
        }
        if (Reflect.get(pass, "isOutputPass") === true) {
          throw new TypeError(
            "GLTS effects must not include OutputPass; GLTSRenderer handles final output"
          );
        }
        // WebGLRenderer rejects incompatible output buffers without throwing.
        const setSize = pass.setSize.bind(pass);
        pass.setSize = (width, height) => {
          this.#effectsSupported = true;
          setSize(width, height);
        };
        // Defer errors until Three's compositor has restored its internal state.
        const render = pass.render.bind(pass);
        pass.render = (...args: Parameters<Pass["render"]>) => {
          if (this.#effectFailed) {
            return;
          }
          try {
            render(args[0], args[1], args[2], this.#delta, args[4]);
          } catch (error) {
            this.#effectError = error;
            this.#effectFailed = true;
          }
        };
      }
    } catch (error) {
      disposeAfterFailure(passes, error);
    }

    this.#effects.set(scene, {
      camera,
      factories: factories.slice(),
      passes,
      source: factories
    });
    return passes;
  }
}
