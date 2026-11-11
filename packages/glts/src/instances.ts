import * as THREE from "three/webgpu";

import type { ScriptRoot } from "./root.js";
import type { GLTSInstances, GLTSScene, InstancedObject } from "./types.js";

/** What InstancedMesh targets cull by when nothing bounds a storage `instanceMatrix`: never culled. */
const unbounded = new THREE.Sphere(new THREE.Vector3(), Infinity);

interface Forwarded {
  readonly targets: readonly InstancedObject[];
  readonly matrix: THREE.InstancedBufferAttribute;
  readonly color: THREE.InstancedBufferAttribute | null;
  readonly version: number;
  readonly count: number;
}

/**
 * Gives `node` InstancedMesh's instancing data for `initialCount` instances at the origin, which its `updateMatrixWorld()`
 * forwards to `targets()`, the instanced objects of its current execution, before the renderer culls them.
 */
export function addInstancing(
  node: ScriptRoot & GLTSScene,
  initialCount: number,
  targets: () => readonly InstancedObject[]
): ScriptRoot & GLTSInstances {
  const identity = new THREE.Matrix4().elements;
  const sphere = new THREE.Sphere();
  let forwarded: Forwarded | undefined;

  /** Forwards the data to the targets; returns whether their culling spheres may no longer fit. */
  const forward = (): boolean => {
    const { instanceMatrix: matrix, instanceColor: color, count, boundingBox, clusters } = instances;
    // InstancedMesh holds 3 floats per color; WGSL storage pads a color to 4.
    if (matrix.itemSize !== 16 || (color && color.itemSize !== (color instanceof THREE.StorageInstancedBufferAttribute ? 4 : 3))) {
      throw new TypeError("GLTS instanceMatrix must hold 16 floats per instance, and instanceColor 3, or 4 in storage");
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > matrix.count) {
      throw new RangeError(`GLTS instance count must be an integer from 0 to instanceMatrix.count, ${matrix.count}, not ${count}`);
    }
    const current = targets();
    const last = forwarded;
    const replaced = current === last?.targets && (matrix !== last.matrix || color !== last.color);
    forwarded = { targets: current, matrix, color, count, version: matrix.version };
    for (const target of current) {
      Object.assign(target, { instanceMatrix: matrix, instanceColor: color, count, boundingBox, clusters });
      // Three bakes an InstancedMesh's attributes into its shaders, which only its `dispose` event rebuilds; replacing
      // the mesh instead would leave the script's references to it stale.
      if (replaced && target instanceof THREE.InstancedMesh) target.dispatchEvent({ type: "dispose" });
    }
    return !last || replaced || current !== last.targets || matrix.version !== last.version || count !== last.count;
  };

  const instances: ScriptRoot & GLTSInstances = Object.assign(node, {
    instanceMatrix: new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: initialCount }, () => identity).flat()), 16),
    instanceColor: null,
    count: initialCount,
    boundingBox: null,
    clusters: undefined,
    computeBoundingBox(): void {
      const box = instances.boundingBox ?? new THREE.Box3();
      // Unset, so InstancedMesh targets compute boxes of their own rather than into the host's.
      instances.boundingBox = null;
      forward();
      box.makeEmpty();
      for (const target of targets()) {
        target.computeBoundingBox();
        if (!target.boundingBox) throw new TypeError("GLTS instanced object's computeBoundingBox() did not set its boundingBox");
        box.union(target.boundingBox);
      }
      instances.boundingBox = box;
      forward();
    },
    getMatrixAt: (index: number, matrix: THREE.Matrix4): THREE.Matrix4 => matrix.fromArray(instances.instanceMatrix.array, index * 16),
    setMatrixAt(index: number, matrix: THREE.Matrix4): ScriptRoot & GLTSInstances {
      matrix.toArray(instances.instanceMatrix.array, index * 16);
      return instances;
    },
    getColorAt(index: number, color: THREE.Color): THREE.Color {
      const colors = instances.instanceColor;
      return colors ? color.fromArray(colors.array, index * colors.itemSize) : color.setRGB(1, 1, 1);
    },
    setColorAt(index: number, color: THREE.Color): ScriptRoot & GLTSInstances {
      instances.instanceColor ??= new THREE.InstancedBufferAttribute(new Float32Array(instances.instanceMatrix.count * 3).fill(1), 3);
      color.toArray(instances.instanceColor.array, index * instances.instanceColor.itemSize);
      return instances;
    },
    updateMatrixWorld(force?: boolean): void {
      const box = instances.boundingBox;
      // A set box is read again every frame, as hosts edit it in place; without one, three bounds a CPU array itself.
      if (forward() || box) {
        const bound = box ? box.getBoundingSphere(sphere) : instances.instanceMatrix instanceof THREE.StorageInstancedBufferAttribute ? unbounded : null;
        for (const target of targets()) if (target instanceof THREE.InstancedMesh) target.boundingSphere = bound;
      }
      THREE.Object3D.prototype.updateMatrixWorld.call(instances, force);
    },
  });
  return instances;
}
