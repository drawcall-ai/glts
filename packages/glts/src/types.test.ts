import { expect, expectTypeOf, it } from "vitest";
import type * as THREE from "three";

import {
  GLTSLoader,
  loadingManager,
  type GLTSConstructor,
  type GLTSInstance
} from "./index.js";

it("exports the managed constructor API", () => {
  expectTypeOf<GLTSInstance>().toExtend<THREE.Group>();
  expectTypeOf<GLTSInstance["ready"]>().toEqualTypeOf<Promise<void>>();
  expectTypeOf<InstanceType<GLTSConstructor>>().toEqualTypeOf<GLTSInstance>();
  expectTypeOf<GLTSLoader["loadAsyncConstructor"]>()
    .returns.toEqualTypeOf<Promise<GLTSConstructor>>();
  expectTypeOf(loadingManager).toEqualTypeOf<THREE.LoadingManager>();
  expect(GLTSLoader).toBeTypeOf("function");
});

it("rejects loadingManager use outside a GLTS asset", () => {
  expect(() => loadingManager.itemStart("test://resource")).toThrow(
    "@drawcall/glts loadingManager is only available inside a .glts module loaded by GLTSLoader"
  );
  expect(() => {
    loadingManager.onLoad = () => undefined;
  }).toThrow(
    "@drawcall/glts loadingManager is only available inside a .glts module loaded by GLTSLoader"
  );
});
