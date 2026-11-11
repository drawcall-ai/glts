import * as THREE from "three";

import { GLTSError, runAll } from "../errors.js";
import type { InstancedObject } from "../types.js";

const identity = new THREE.Matrix4();

/** Whether a node forwards its instancing data to `object`, an object with three's InstancedMesh shape. */
function isInstanced(object: THREE.Object3D): object is InstancedObject {
  return "instanceMatrix" in object && object.instanceMatrix instanceof THREE.InstancedBufferAttribute;
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

function visibleBelowRoot(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current && current !== root; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

/** The transform of `object` in `root`'s space. */
function relativeMatrix(object: THREE.Object3D, root: THREE.Object3D): THREE.Matrix4 {
  const matrix = object.matrix.clone();
  for (let parent = object.parent; parent && parent !== root; parent = parent.parent) matrix.premultiply(parent.matrix);
  return matrix;
}

/** `geometry` transformed by `matrix`, its triangles' winding reversed when `matrix` mirrors, as three does for a mesh. */
function bake(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const baked = geometry.clone().applyMatrix4(matrix);
  if (matrix.determinant() >= 0) return baked;
  if (!baked.index) baked.setIndex([...Array(baked.getAttribute("position").count).keys()]);
  const index = baked.index;
  if (!index) throw new Error("GLTS could not index a mirrored geometry");
  for (let first = 0; first + 2 < index.count; first += 3) {
    const second = index.getX(first + 1);
    index.setX(first + 1, index.getX(first + 2));
    index.setX(first + 2, second);
  }
  return baked;
}

/** An InstancedMesh drawing `mesh` at each instance, with its transform in `root` baked into its geometry. */
function instanceMesh(mesh: THREE.Mesh, root: THREE.Object3D): THREE.InstancedMesh {
  const relative = relativeMatrix(mesh, root);
  const geometry = relative.equals(identity) ? mesh.geometry : bake(mesh.geometry, relative);
  const instanced = Object.assign(new THREE.InstancedMesh(geometry, mesh.material, 0), {
    castShadow: mesh.castShadow,
    customDepthMaterial: mesh.customDepthMaterial,
    customDistanceMaterial: mesh.customDistanceMaterial,
    frustumCulled: mesh.frustumCulled,
    name: mesh.name,
    onAfterRender: mesh.onAfterRender,
    onAfterShadow: mesh.onAfterShadow,
    onBeforeRender: mesh.onBeforeRender,
    onBeforeShadow: mesh.onBeforeShadow,
    receiveShadow: mesh.receiveShadow,
    renderOrder: mesh.renderOrder,
    userData: mesh.userData,
    visible: visibleBelowRoot(mesh, root),
  });
  instanced.layers.mask = mesh.layers.mask;
  return instanced;
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
 * Takes over the targets of an asset loaded as instances: the topmost objects with an `instanceMatrix`, which must sit
 * at its origin, since the host's matrices place the asset, and hold no copies of their own. Every plain mesh becomes an
 * InstancedMesh target at the root, and the rest of the scene goes. `nodes` are the asset's nested nodes, and `frames`
 * whether the script registered onFrame callbacks.
 */
export function takeTargets(root: THREE.Scene, nodes: readonly THREE.Object3D[], frames: boolean, url: string): Targets {
  root.updateMatrixWorld(true);
  const targets: InstancedObject[] = [];
  const meshes: THREE.Mesh[] = [];
  const visit = (object: THREE.Object3D): void => {
    const name = object.name || `a THREE.${object.type}`;
    if (isInstanced(object)) {
      if (hasCopies(object)) {
        throw new GLTSError(
          `This asset scatters its own copies with ${name}; load it with loadAsync()`,
          { phase: "construct", url }
        );
      }
      if (object instanceof THREE.InstancedMesh && object.children.length > 0) {
        throw new GLTSError(`${name} has children, which would draw once; add them beside it instead`, { phase: "construct", url });
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
    if (nodes.includes(object)) {
      throw new GLTSError("Instanced assets cannot contain nested scenes; load them with loadInstancesAsync(url, 1)", { phase: "construct", url });
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
