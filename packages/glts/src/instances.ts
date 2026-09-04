import * as THREE from "three";

import { GLTSError } from "./errors.js";

export interface AutoInstances {
  dispose(): void;
  setMatrixAt(index: number, matrix: THREE.Matrix4): void;
}

function unsupported(object: THREE.Object3D): boolean {
  return (
    object instanceof THREE.BatchedMesh ||
    object instanceof THREE.Camera ||
    object instanceof THREE.InstancedMesh ||
    object instanceof THREE.Light ||
    object instanceof THREE.Line ||
    object instanceof THREE.LOD ||
    object instanceof THREE.Points ||
    object instanceof THREE.SkinnedMesh ||
    object instanceof THREE.Sprite
  );
}

function copyRenderState(source: THREE.Mesh, target: THREE.InstancedMesh): void {
  target.castShadow = source.castShadow;
  target.customDepthMaterial = source.customDepthMaterial;
  target.customDistanceMaterial = source.customDistanceMaterial;
  target.frustumCulled = source.frustumCulled;
  target.layers.mask = source.layers.mask;
  target.name = source.name;
  target.onAfterRender = source.onAfterRender;
  target.onAfterShadow = source.onAfterShadow;
  target.onBeforeRender = source.onBeforeRender;
  target.onBeforeShadow = source.onBeforeShadow;
  target.receiveShadow = source.receiveShadow;
  target.renderOrder = source.renderOrder;
  target.userData = source.userData;
  target.visible = source.visible;
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

export function createAutoInstances(
  scene: THREE.Scene,
  matrices: readonly THREE.Matrix4[],
  url: string
): AutoInstances {
  scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  let invalid: THREE.Object3D | undefined;

  scene.traverse((object) => {
    if (object === scene || invalid) {
      return;
    }

    if (unsupported(object)) {
      invalid = object;
      return;
    }

    if (object instanceof THREE.Mesh) {
      if (object.morphTargetInfluences) {
        invalid = object;
        return;
      }
      meshes.push(object);
    }
  });

  if (invalid) {
    throw new GLTSError(
      `Automatic instancing does not support THREE.${invalid.type}; implement native instancing with onMatrixUpdateAt()`,
      { phase: "construct", url }
    );
  }

  if (meshes.length === 0) {
    throw new GLTSError(
      "Automatic instancing requires at least one mesh; implement native instancing with onMatrixUpdateAt()",
      { phase: "construct", url }
    );
  }

  const inverseRoot = scene.matrixWorld.clone().invert();
  const targets = meshes.map((mesh) => {
    const relative = inverseRoot.clone().multiply(mesh.matrixWorld);
    const target = new THREE.InstancedMesh(mesh.geometry, mesh.material, matrices.length);
    copyRenderState(mesh, target);
    target.visible = visibleBelowRoot(mesh, scene);
    return { relative, target };
  });

  const ownership = new THREE.Group();
  ownership.name = "GLTS source ownership";
  ownership.visible = false;
  while (scene.children.length > 0) {
    const child = scene.children[0];
    if (!child) {
      break;
    }
    ownership.add(child);
  }
  ownership.traverse((object) => object.layers.disableAll());
  scene.add(ownership, ...targets.map(({ target }) => target));

  const combined = new THREE.Matrix4();
  const setMatrixAt = (index: number, matrix: THREE.Matrix4): void => {
    for (const { relative, target } of targets) {
      combined.multiplyMatrices(matrix, relative);
      target.setMatrixAt(index, combined);
      target.instanceMatrix.needsUpdate = true;
      target.boundingBox = null;
      target.boundingSphere = null;
    }
  };

  for (const [index, matrix] of matrices.entries()) {
    setMatrixAt(index, matrix);
  }

  return {
    dispose: () => {
      const errors: unknown[] = [];
      for (const { target } of targets) {
        try {
          target.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Automatic instance disposal failed");
      }
    },
    setMatrixAt
  };
}
