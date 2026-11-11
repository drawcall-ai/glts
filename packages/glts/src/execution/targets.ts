import * as THREE from "three";

import { GLTSError, runAll } from "../errors.js";
import type { InstancedObject } from "../types.js";

const identity = new THREE.Matrix4();

function hasInstanceMatrix(object: THREE.Object3D): boolean {
  return "instanceMatrix" in object && object.instanceMatrix instanceof THREE.InstancedBufferAttribute;
}

/** Whether `object` has three's InstancedMesh shape, which a node forwards its instancing data to. */
function isInstanced(object: THREE.Object3D): object is InstancedObject {
  return hasInstanceMatrix(object) && typeof object.count === "number"
    && "computeBoundingBox" in object && typeof object.computeBoundingBox === "function";
}

function isUnsupportedForInstancing(object: THREE.Object3D): boolean {
  return (
    object instanceof THREE.BatchedMesh ||
    object instanceof THREE.Camera ||
    object instanceof THREE.Light ||
    object instanceof THREE.Line ||
    object instanceof THREE.LOD ||
    object instanceof THREE.Points ||
    object instanceof THREE.SkinnedMesh ||
    object instanceof THREE.Sprite
  );
}

function copyRenderState(mesh: THREE.Mesh, target: THREE.InstancedMesh): void {
  target.castShadow = mesh.castShadow;
  target.customDepthMaterial = mesh.customDepthMaterial;
  target.customDistanceMaterial = mesh.customDistanceMaterial;
  target.frustumCulled = mesh.frustumCulled;
  target.layers.mask = mesh.layers.mask;
  target.name = mesh.name;
  target.onAfterRender = mesh.onAfterRender;
  target.onAfterShadow = mesh.onAfterShadow;
  target.onBeforeRender = mesh.onBeforeRender;
  target.onBeforeShadow = mesh.onBeforeShadow;
  target.receiveShadow = mesh.receiveShadow;
  target.renderOrder = mesh.renderOrder;
  target.userData = mesh.userData;
  target.visible = mesh.visible;
}

function visibleBelowRoot(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current && current !== root) {
    if (!current.visible) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

/** The transform of `object` in `root`'s space. */
function relativeMatrix(object: THREE.Object3D, root: THREE.Object3D): THREE.Matrix4 {
  const matrix = object.matrix.clone();
  for (let parent = object.parent; parent && parent !== root; parent = parent.parent) matrix.premultiply(parent.matrix);
  return matrix;
}

/** An InstancedMesh drawing `mesh` at each instance, with its transform in `root` baked into its geometry. */
function instanceMesh(mesh: THREE.Mesh, root: THREE.Object3D): THREE.InstancedMesh {
  const relative = relativeMatrix(mesh, root);
  const geometry = relative.equals(identity) ? mesh.geometry : mesh.geometry.clone().applyMatrix4(relative);
  const instanced = new THREE.InstancedMesh(geometry, mesh.material, 0);
  copyRenderState(mesh, instanced);
  instanced.visible = visibleBelowRoot(mesh, root);
  return instanced;
}

export interface TargetOptions {
  /** The asset's nested nodes. */
  readonly nodes: ReadonlySet<THREE.Object3D>;
  /** Whether the script registered onFrame callbacks. */
  readonly frames: boolean;
  readonly url: string;
}

/** An execution's targets: the instanced objects its node forwards its instancing data to. */
export interface Targets {
  readonly targets: readonly InstancedObject[];
  /** Disposes what automatic instancing created. */
  dispose(): void;
}

/** Whether `object` holds instances of its own, which the host's would replace: more than one, or one moved. */
function hasCopies(object: InstancedObject): boolean {
  const first = new THREE.Matrix4().fromArray(object.instanceMatrix.array);
  return object.count > 1 || (object.count === 1 && !first.equals(identity));
}

/**
 * Finds the targets of an asset loaded as instances: the topmost objects with an `instanceMatrix`, which must sit at
 * its origin, since the host's matrices place the asset, and hold no copies of their own. Every plain mesh becomes an
 * InstancedMesh target at the root, and the rest of the scene goes.
 */
export function findTargets(root: THREE.Scene, options: TargetOptions): Targets {
  const { nodes, frames, url } = options;
  root.updateMatrixWorld(true);
  const targets: InstancedObject[] = [];
  const meshes: THREE.Mesh[] = [];
  const visit = (object: THREE.Object3D): void => {
    const name = object.name || `a THREE.${object.type}`;
    if (hasInstanceMatrix(object) && !isInstanced(object)) {
      throw new GLTSError(`${name} has an instanceMatrix but not InstancedMesh's count and computeBoundingBox()`, { phase: "construct", url });
    }
    if (isInstanced(object)) {
      if (hasCopies(object)) {
        throw new GLTSError(
          `This asset scatters its own copies with ${name}; load it with loadAsync()`,
          { phase: "construct", url }
        );
      }
      if (!relativeMatrix(object, root).equals(identity)) {
        throw new GLTSError(
          `Instanced objects must sit at the asset's origin, but ${name} does not; move the offset into the child asset`,
          { phase: "construct", url }
        );
      }
      targets.push(object);
      return;
    }
    if (nodes.has(object)) {
      throw new GLTSError("Instanced assets cannot contain nested scenes; load them with loadInstancesAsync()", { phase: "construct", url });
    }
    if (isUnsupportedForInstancing(object) || (object instanceof THREE.Mesh && object.morphTargetInfluences)) {
      throw new GLTSError(`Automatic instancing does not support THREE.${object.type}`, { phase: "construct", url });
    }
    if (object instanceof THREE.Mesh) meshes.push(object);
    for (const child of object.children) visit(child);
  };
  for (const child of root.children) visit(child);

  if (meshes.length === 0) {
    if (targets.length === 0) {
      throw new GLTSError("Instanced assets require at least one mesh or instanced object", { phase: "construct", url });
    }
    return { targets, dispose: () => undefined };
  }
  if (frames) {
    throw new GLTSError(
      "Automatically instanced scripts cannot use onFrame(); instance the meshes yourself with an InstancedMesh",
      { phase: "construct", url }
    );
  }

  const clones: THREE.BufferGeometry[] = [];
  const created = meshes.map((mesh) => {
    const instance = instanceMesh(mesh, root);
    if (instance.geometry !== mesh.geometry) clones.push(instance.geometry);
    return instance;
  });
  const kept = new Set<THREE.Object3D>(targets);
  for (const target of targets) {
    target.visible &&= visibleBelowRoot(target, root);
    root.attach(target);
  }
  root.remove(...root.children.filter((child) => !kept.has(child)));
  root.add(...created);
  return {
    targets: [...targets, ...created],
    dispose: () => runAll("Automatic instance disposal failed", [...created, ...clones].map((resource) => () => resource.dispose())),
  };
}
