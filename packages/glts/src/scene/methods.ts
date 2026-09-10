import * as THREE from "three";

import type { GLTSInstances, GLTSScene } from "../types.js";
import type { NodeRecord } from "./registry.js";
import type { GLTSScriptScene } from "./state.js";

export type GLTSNode = GLTSInstances | GLTSScene;
export type GLTSNodeKind = "instances" | "scene";

export interface SceneMethods {
  readonly physics: () => boolean;
  readonly dispose: () => void;
  readonly reload: () => Promise<void>;
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
    capabilities: {
      value: Object.freeze({
        get physics() { return methods.physics(); }
      })
    },
    dispose: { value: methods.dispose },
    reload: { value: methods.reload },
    update: { value: methods.update },
    url: { value: url }
  });
}

function isManagedScene(value: unknown): value is GLTSScene {
  return (
    value instanceof THREE.Scene &&
    "rendering" in value &&
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "dispose") === "function" &&
    typeof Reflect.get(value, "reload") === "function" &&
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
      const target = matrixAt(current, index).copy(matrix);
      if (current.revision.execution.nativeInstances) {
        current.revision.execution.setMatrixAt(index, target);
      } else {
        current.revision.automatic?.setMatrixAt(index, target);
      }
    }
  };
}
