import * as THREE from "three";
import type { Pass } from "three/addons/postprocessing/Pass.js";

import type { GLTSScene } from "../types.js";
import type { GLTSEffect } from "../scene/state.js";

interface EffectSet {
  readonly camera: THREE.Camera;
  readonly factories: readonly GLTSEffect[];
  readonly source: GLTSEffect[];
  readonly passes: Pass[];
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

export class Effects {
  readonly #effects = new Map<GLTSScene, EffectSet>();
  readonly #renderer: THREE.WebGLRenderer;
  readonly #size = new THREE.Vector2();
  #effectError: unknown;
  #effectFailed = false;
  #effectsSupported = false;
  #delta = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.#renderer = renderer;
  }

  render(
    scene: GLTSScene,
    camera: THREE.Camera,
    delta: number,
    beforeRender: () => void
  ): void {
    this.#delta = delta;
    this.#effectError = undefined;
    this.#effectFailed = false;
    const effects = this.#refreshPasses(scene, camera);
    let installed = false;
    try {
      // Factories observe host state before the root profile is applied.
      beforeRender();
      if (effects.length > 0) {
        installed = true;
        this.#renderer.setEffects(effects);
        if (!this.#effectsSupported) {
          installed = false;
          this.#effects.delete(scene);
          disposeAfterFailure(
            effects,
            new Error(
              "GLTS effects require a WebGLRenderer constructed with GLTSRenderer.parameters"
            )
          );
        }
      }
      this.#renderer.render(scene, camera);
      if (this.#effectFailed) {
        throw this.#effectError;
      }
    } finally {
      if (installed) this.#renderer.setEffects(null);
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
    const passes = [...this.#effects.values()].flatMap((effects) => effects.passes);
    this.#effects.clear();
    disposePasses(passes);
  }

  #refreshPasses(scene: GLTSScene, camera: THREE.Camera): Pass[] {
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
        this.#adaptPassForRenderer(pass);
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

  #adaptPassForRenderer(pass: Pass): void {
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
    pass.render = (renderer, writeBuffer, readBuffer, _delta, maskActive) => {
      if (this.#effectFailed) {
        return;
      }
      try {
        render(renderer, writeBuffer, readBuffer, this.#delta, maskActive);
      } catch (error) {
        this.#effectError = error;
        this.#effectFailed = true;
      }
    };
  }
}
