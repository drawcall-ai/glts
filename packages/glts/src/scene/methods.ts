import * as THREE from "three";

import type { GLTSInstances, GLTSScene } from "../types.js";
import type { NodeRecord } from "./nodes.js";
import type { GLTSScriptScene } from "./root.js";

export interface SceneMethods {
  readonly dispose: () => void;
  readonly update: (delta: number) => void;
}

export interface InstanceMethods extends SceneMethods {
  readonly count: number;
  readonly getMatrixAt: (index: number, matrix: THREE.Matrix4) => THREE.Matrix4;
  readonly setMatrixAt: (index: number, matrix: THREE.Matrix4) => void;
}

function defineSceneMethods(
  scene: GLTSScriptScene,
  url: string,
  methods: SceneMethods
): void {
  Object.defineProperties(scene, {
    dispose: { value: methods.dispose },
    update: { value: methods.update },
    url: { value: url }
  });
}

// defineProperties cannot change a static type, so these guards narrow the augmented scene.
function isManagedScene(value: unknown): value is GLTSScene {
  return (
    value instanceof THREE.Scene &&
    "rendering" in value &&
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "dispose") === "function" &&
    typeof Reflect.get(value, "update") === "function"
  );
}

function isManagedInstances(value: unknown): value is GLTSInstances {
  return (
    isManagedScene(value) &&
    typeof Reflect.get(value, "count") === "number" &&
    typeof Reflect.get(value, "getMatrixAt") === "function" &&
    typeof Reflect.get(value, "setMatrixAt") === "function"
  );
}

export function attachSceneMethods(
  scene: GLTSScriptScene,
  url: string,
  methods: SceneMethods
): GLTSScene {
  defineSceneMethods(scene, url, methods);
  if (!isManagedScene(scene)) {
    throw new Error("Unable to create a managed GLTS scene");
  }

  return scene;
}

export function attachInstanceMethods(
  scene: GLTSScriptScene,
  url: string,
  methods: InstanceMethods
): GLTSInstances {
  defineSceneMethods(scene, url, methods);
  Object.defineProperties(scene, {
    count: { value: methods.count },
    getMatrixAt: { value: methods.getMatrixAt },
    setMatrixAt: {
      value: (index: number, matrix: THREE.Matrix4) => {
        methods.setMatrixAt(index, matrix);
        return scene;
      }
    }
  });
  if (!isManagedInstances(scene)) {
    throw new Error("Unable to create a managed GLTS instances node");
  }

  return scene;
}

export function createInstanceMatrixMethods(getRecord: () => NodeRecord): Pick<InstanceMethods, "getMatrixAt" | "setMatrixAt"> {
  const matrixAt = (current: NodeRecord, index: number): THREE.Matrix4 => {
    const matrix = current.matrices[index];
    if (!Number.isSafeInteger(index) || !matrix) {
      throw new RangeError(`GLTS instance index is out of range: ${index}`);
    }
    return matrix;
  };
  return {
    getMatrixAt: (index, matrix) => matrix.copy(matrixAt(getRecord(), index)),
    setMatrixAt: (index, matrix) => {
      const current = getRecord();
      current.execution.setMatrixAt(index, matrixAt(current, index).copy(matrix));
    }
  };
}
