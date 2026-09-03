import { expect, expectTypeOf, it } from "vitest";
import * as THREE from "three";

import {
  GLTSLoader,
  gltsLoader,
  instanceCount,
  loadingManager,
  onDispose,
  onFrame,
  onMatrixUpdateAt,
  isPreview,
  scene,
  type GLTSInstances,
  type GLTSScene
} from "./index.js";

it("exports the host and contextual script APIs", () => {
  expectTypeOf<GLTSScene>().toExtend<THREE.Group>();
  expectTypeOf<GLTSInstances>().toExtend<THREE.Group>();
  expectTypeOf<ReturnType<GLTSScene["clone"]>>().toEqualTypeOf<THREE.Group>();
  expectTypeOf<ReturnType<GLTSInstances["clone"]>>().toEqualTypeOf<THREE.Group>();
  expectTypeOf<ReturnType<GLTSInstances["getMatrixAt"]>>()
    .toEqualTypeOf<THREE.Matrix4>();
  expectTypeOf<ReturnType<GLTSInstances["setMatrixAt"]>>()
    .toEqualTypeOf<GLTSInstances>();
  expectTypeOf<ConstructorParameters<typeof GLTSLoader>[0]>()
    .toEqualTypeOf<THREE.LoadingManager>();
  expectTypeOf<GLTSLoader["loadAsync"]>().returns.toEqualTypeOf<Promise<GLTSScene>>();
  expectTypeOf<GLTSLoader["loadInstancesAsync"]>()
    .returns.toEqualTypeOf<Promise<GLTSInstances>>();
  expectTypeOf(loadingManager).toEqualTypeOf<THREE.LoadingManager>();
  expectTypeOf(scene).toEqualTypeOf<THREE.Group>();
  expectTypeOf(instanceCount).toEqualTypeOf<number>();
  expectTypeOf(isPreview).toEqualTypeOf<boolean>();
  expect(GLTSLoader).toBeTypeOf("function");
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
