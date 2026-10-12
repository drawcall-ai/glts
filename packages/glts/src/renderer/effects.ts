import * as THREE from "three";
import type { Pass } from "three/addons/postprocessing/Pass.js";

import { cleanUpAndThrow, runAll } from "../errors.js";
import type { GLTSScene } from "../types.js";
import type { GLTSEffect } from "../scene/root.js";

interface EffectSet {
  readonly camera: THREE.Camera;
  readonly factories: readonly GLTSEffect[];
  readonly source: GLTSEffect[];
  readonly passes: Pass[];
}

function disposePasses(passes: readonly Pass[]): void {
  runAll("GLTS effects disposal failed", passes.map((pass) => () => pass.dispose()));
}

export class Effects {
  readonly #effects = new Map<GLTSScene, EffectSet>();
  readonly #renderer: THREE.WebGLRenderer;
  readonly #size = new THREE.Vector2();
  #failure: { readonly error: unknown } | undefined;
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
    const passes = this.#refreshPasses(scene, camera);
    // Factories observe host state before the root profile is applied.
    beforeRender();
    if (passes.length === 0) {
      this.#renderer.render(scene, camera);
      return;
    }
    let failure;
    try {
      this.#renderer.setEffects(passes);
      if (!this.#effectsSupported) {
        this.#effects.delete(scene);
        cleanUpAndThrow(
          new Error("GLTS effects require a WebGLRenderer constructed with GLTSRenderer.parameters"),
          scene.url,
          () => disposePasses(passes)
        );
      }
      this.#renderer.render(scene, camera);
    } finally {
      // An unsupported renderer installs nothing, so there is nothing to undo.
      if (this.#effectsSupported) this.#renderer.setEffects(null);
      failure = this.#failure;
      this.#failure = undefined;
    }
    if (failure) {
      throw failure.error;
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
      cleanUpAndThrow(error, scene.url, () => disposePasses(passes));
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
      if (this.#failure) {
        return;
      }
      try {
        render(renderer, writeBuffer, readBuffer, this.#delta, maskActive);
      } catch (error) {
        this.#failure = { error };
      }
    };
  }
}
