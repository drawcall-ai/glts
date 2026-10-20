import * as THREE from "three";
import type { Pass } from "three/addons/postprocessing/Pass.js";

import { cleanUpAndThrow, runAll } from "../errors.js";
import type { GLTSEffect, GLTSScene } from "../types.js";
import { onNodeDispose } from "../node.js";

interface EffectSet {
  readonly camera: THREE.Camera;
  /** A copy of `effects`, so a change made in place is noticed. */
  readonly snapshot: readonly GLTSEffect[];
  /** The scene's `rendering.effects`, compared by identity, so a reload, which copies the array, rebuilds passes of unchanged effects. */
  readonly effects: GLTSEffect[];
  readonly passes: Pass[];
  readonly removeListener: () => void;
}

function disposePasses(passes: readonly Pass[]): void {
  runAll("GLTS effects disposal failed", passes.map((pass) => () => pass.dispose()));
}

export class Effects {
  readonly #sets = new Map<GLTSScene, EffectSet>();
  readonly #renderer: THREE.WebGLRenderer;
  readonly #size = new THREE.Vector2();
  #failure: { readonly error: unknown } | undefined;
  #passesAccepted = false;
  #delta = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.#renderer = renderer;
  }

  /** Renders `scene` through `passes`, or directly without any. */
  render(scene: GLTSScene, camera: THREE.Camera, passes: Pass[], delta: number): void {
    if (passes.length === 0) {
      this.#renderer.render(scene, camera);
      return;
    }
    this.#delta = delta;
    let failure;
    try {
      this.#renderer.setEffects(passes);
      if (!this.#passesAccepted) {
        cleanUpAndThrow(
          new Error("GLTS effects require a WebGLRenderer constructed with GLTSRenderer.parameters"),
          scene.url,
          () => this.#release(scene)
        );
      }
      this.#renderer.render(scene, camera);
    } finally {
      // An unsupported renderer installs nothing, so there is nothing to undo.
      if (this.#passesAccepted) this.#renderer.setEffects(null);
      failure = this.#failure;
      this.#failure = undefined;
    }
    if (failure) {
      throw failure.error;
    }
  }

  dispose(): void {
    runAll("GLTS effects disposal failed", [...this.#sets.keys()].map((scene) => () => this.#release(scene)));
  }

  #release(scene: GLTSScene): void {
    const set = this.#sets.get(scene);
    if (!set) {
      return;
    }
    this.#sets.delete(scene);
    set.removeListener();
    disposePasses(set.passes);
  }

  /** The passes of the effects of `scene` for `camera`, made again when its effects or `camera` change. */
  prepare(scene: GLTSScene, camera: THREE.Camera): Pass[] {
    const effects = scene.rendering.effects;
    const current = this.#sets.get(scene);
    if (
      current &&
      current.camera === camera &&
      current.effects === effects &&
      current.snapshot.length === effects.length &&
      current.snapshot.every((effect, index) => effect === effects[index])
    ) {
      return current.passes;
    }

    this.#release(scene);
    if (effects.length === 0) {
      return [];
    }

    const removeListener = onNodeDispose(scene, () => this.#release(scene));
    const size = this.#renderer.getDrawingBufferSize(this.#size);
    const passes: Pass[] = [];
    try {
      for (const effect of effects) {
        const pass = effect({
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
          throw new TypeError("GLTS effects must not include RenderPass; GLTSRenderer renders the selected scene and camera");
        }
        if (Reflect.get(pass, "isOutputPass") === true) {
          throw new TypeError("GLTS effects must not include OutputPass; GLTSRenderer handles final output");
        }
        this.#instrument(pass);
      }
    } catch (error) {
      cleanUpAndThrow(error, scene.url, () => {
        removeListener();
        disposePasses(passes);
      });
    }

    this.#sets.set(scene, {
      camera,
      effects,
      snapshot: effects.slice(),
      passes,
      removeListener
    });
    return passes;
  }

  /** Notes when the renderer accepts `pass`, and defers its render errors. */
  #instrument(pass: Pass): void {
    // WebGLRenderer rejects incompatible output buffers without throwing.
    const setSize = pass.setSize.bind(pass);
    pass.setSize = (width, height) => {
      this.#passesAccepted = true;
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
