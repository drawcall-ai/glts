import * as THREE from "three";

import type { GLTSInstances, GLTSScene } from "./types.js";

export type GLTSNode = GLTSInstances | GLTSScene;
export type GLTSNodeKind = "instances" | "scene";

export interface SceneMethods {
  readonly dispose: () => void;
  readonly reload: () => Promise<void>;
  readonly update: (delta: number) => void;
}

export interface InstanceMethods extends SceneMethods {
  readonly count: number;
  readonly getMatrixAt: (index: number, matrix: THREE.Matrix4) => THREE.Matrix4;
  readonly setMatrixAt: (index: number, matrix: THREE.Matrix4) => void;
}

function defineCommon(
  scene: THREE.Group,
  url: string,
  methods: SceneMethods
): void {
  Object.defineProperties(scene, {
    dispose: { value: methods.dispose },
    reload: { value: methods.reload },
    update: { value: methods.update },
    url: { value: url }
  });
}

function isScene(value: unknown): value is GLTSScene {
  return (
    value instanceof THREE.Group &&
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "dispose") === "function" &&
    typeof Reflect.get(value, "reload") === "function" &&
    typeof Reflect.get(value, "update") === "function"
  );
}

function isInstances(value: unknown): value is GLTSInstances {
  return (
    isScene(value) &&
    typeof Reflect.get(value, "count") === "number" &&
    typeof Reflect.get(value, "getMatrixAt") === "function" &&
    typeof Reflect.get(value, "setMatrixAt") === "function"
  );
}

export function createSceneNode(
  scene: THREE.Group,
  url: string,
  methods: SceneMethods
): GLTSScene {
  defineCommon(scene, url, methods);
  if (!isScene(scene)) {
    throw new Error("Unable to create a managed GLTS scene");
  }

  return scene;
}

export function createInstancesNode(
  scene: THREE.Group,
  url: string,
  methods: InstanceMethods
): GLTSInstances {
  defineCommon(scene, url, methods);
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
  if (!isInstances(scene)) {
    throw new Error("Unable to create a managed GLTS instances node");
  }

  return scene;
}
