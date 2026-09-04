import { expect, expectTypeOf, it } from "vitest";
import * as THREE from "three";

import {
  GLTSLoader,
  GLTSRenderer,
  gltsLoader,
  instanceCount,
  loadingManager,
  onDispose,
  onFrame,
  onMatrixUpdateAt,
  isPreview,
  scene,
  type GLTSInstances,
  type GLTSRenderingProfile,
  type GLTSScene
} from "./index.js";

it("exports the host and contextual script APIs", () => {
  expectTypeOf<GLTSScene>().toExtend<THREE.Scene>();
  expectTypeOf<GLTSScene["isScene"]>().toEqualTypeOf<boolean>();
  expectTypeOf<ReturnType<GLTSScene["clone"]>>().toEqualTypeOf<THREE.Scene>();
  expectTypeOf<ReturnType<typeof scene.clone>>().toEqualTypeOf<THREE.Scene>();
  expectTypeOf<ReturnType<GLTSScene["add"]>>().toEqualTypeOf<GLTSScene>();
  expectTypeOf<ReturnType<GLTSScene["copy"]>>().toEqualTypeOf<GLTSScene>();
  expectTypeOf<ReturnType<GLTSScene["rotateY"]>>().toEqualTypeOf<GLTSScene>();
  expectTypeOf<GLTSScene["defaultCamera"]>()
    .toEqualTypeOf<THREE.Camera | undefined>();
  expectTypeOf<GLTSScene["rendering"]>()
    .toEqualTypeOf<GLTSRenderingProfile>();
  expectTypeOf<ReturnType<GLTSInstances["getMatrixAt"]>>()
    .toEqualTypeOf<THREE.Matrix4>();
  expectTypeOf<ReturnType<GLTSInstances["setMatrixAt"]>>()
    .toEqualTypeOf<GLTSInstances>();
  expectTypeOf<ConstructorParameters<typeof GLTSLoader>[0]>()
    .toEqualTypeOf<THREE.LoadingManager>();
  expectTypeOf<ConstructorParameters<typeof GLTSRenderer>[0]>()
    .toEqualTypeOf<THREE.WebGLRenderer>();
  expectTypeOf(GLTSRenderer.parameters.outputBufferType)
    .toEqualTypeOf<typeof THREE.HalfFloatType>();
  expectTypeOf<Parameters<GLTSRenderer["render"]>>()
    .toEqualTypeOf<[
      scene: GLTSScene,
      camera?: THREE.Camera,
      delta?: number
    ]>();
  expectTypeOf<GLTSLoader["loadAsync"]>().returns.toEqualTypeOf<Promise<GLTSScene>>();
  expectTypeOf<GLTSLoader["loadInstancesAsync"]>()
    .returns.toEqualTypeOf<Promise<GLTSInstances>>();
  expectTypeOf(loadingManager).toEqualTypeOf<THREE.LoadingManager>();
  expectTypeOf(scene).toExtend<THREE.Scene>();
  expectTypeOf(instanceCount).toEqualTypeOf<number>();
  expectTypeOf(isPreview).toEqualTypeOf<boolean>();
  expect(GLTSLoader).toBeTypeOf("function");
  expect(GLTSRenderer).toBeTypeOf("function");
  expect(gltsLoader.loadAsync).toBeTypeOf("function");
  expect(onDispose).toBeTypeOf("function");
  expect(onFrame).toBeTypeOf("function");
  expect(onMatrixUpdateAt).toBeTypeOf("function");
});

it("fails contextual object and function use outside a GLTS script", () => {
  expect(() => loadingManager.itemStart("test://resource")).toThrow(
    "only available inside a .glts script"
  );
  expect(() => scene.add(new THREE.Group())).toThrow(
    "only available inside a .glts script"
  );
  expect(() => onFrame(() => undefined)).toThrow(
    "only available inside a .glts script"
  );
});
