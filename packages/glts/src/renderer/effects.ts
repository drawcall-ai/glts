import * as THREE from "three/webgpu";
import { pass } from "three/tsl";

import { cleanUpAndThrow, runAll } from "../errors.js";
import { onNodeDispose } from "../node.js";
import type { GLTSEffect, GLTSScene } from "../types.js";

interface EffectSet {
  readonly camera: THREE.Camera;
  readonly effects: GLTSEffect[];
  /** Detect in-place edits as well as a replacement array, including reloads. */
  readonly snapshot: readonly GLTSEffect[];
  readonly pipeline: THREE.RenderPipeline;
  readonly dispose: () => void;
  readonly removeListener: () => void;
}

function disposeGraph(roots: readonly THREE.Node[], pipeline?: THREE.RenderPipeline): void {
  const nodes = new Set<THREE.Node>();
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || nodes.has(node)) continue;
    nodes.add(node);
    pending.push(...node.getChildren());
  }
  runAll("GLTS effects disposal failed", [
    () => pipeline?.dispose(),
    // Three's shared quad geometry caches the first compiled graph, including user callbacks.
    // Release that cache; other live pipelines recreate the triangle's GPU buffers on their next render.
    () => { if (pipeline) new THREE.QuadMesh().geometry.dispose(); },
    ...[...nodes].map(node => () => node.dispose())
  ]);
}

export class Effects {
  readonly #sets = new Map<GLTSScene, EffectSet>();
  readonly #renderer: THREE.WebGPURenderer;
  readonly #size = new THREE.Vector2();

  constructor(renderer: THREE.WebGPURenderer) {
    this.#renderer = renderer;
  }

  /** Builds the scene's effect graph again when its camera or effect factories change. */
  prepare(scene: GLTSScene, camera: THREE.Camera): THREE.RenderPipeline | undefined {
    const effects = scene.rendering.effects;
    const current = this.#sets.get(scene);
    if (
      current && current.camera === camera && current.effects === effects &&
      current.snapshot.length === effects.length &&
      current.snapshot.every((effect, index) => effect === effects[index])
    ) {
      return current.pipeline;
    }

    this.#release(scene);
    if (effects.length === 0) return;

    const scenePass = pass(scene, camera);
    const roots: THREE.Node[] = [scenePass];
    const output = new THREE.ContextNode(scenePass.getTextureNode());
    let pipeline: THREE.RenderPipeline | undefined;
    const dispose = () => {
      // Addon quads keep their last builder and pipeline context; detach the disposed asset from both.
      output.node = null;
      scenePass.scene = new THREE.Scene();
      scenePass.camera = new THREE.Camera();
      disposeGraph(roots, pipeline);
    };
    try {
      const size = this.#renderer.getDrawingBufferSize(this.#size);
      let input: THREE.Node<"vec4"> = scenePass.getTextureNode();
      for (const effect of effects) {
        const node = effect({ camera, scene, input, width: size.width, height: size.height });
        if (!(node instanceof THREE.Node)) {
          throw new TypeError("GLTS effect factories must return a Three.js TSL node");
        }
        roots.push(node);
        input = node;
      }
      output.node = input;
      pipeline = new THREE.RenderPipeline(this.#renderer, output);
      this.#sets.set(scene, {
        camera, effects, snapshot: effects.slice(), pipeline, dispose,
        removeListener: onNodeDispose(scene, () => this.#release(scene))
      });
      return pipeline;
    } catch (error) {
      cleanUpAndThrow(error, scene.url, dispose);
    }
  }

  dispose(): void {
    runAll("GLTS effects disposal failed", [...this.#sets.keys()].map(scene => () => this.#release(scene)));
  }

  #release(scene: GLTSScene): void {
    const set = this.#sets.get(scene);
    if (!set) return;
    this.#sets.delete(scene);
    set.removeListener();
    set.dispose();
  }
}
