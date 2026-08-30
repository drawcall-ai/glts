import { expectTypeOf, it } from "vitest";
import type * as THREE from "three";

import type { GLTSConstructor, GLTSInstance } from "./types.js";
import type { GLTSLoader } from "./GLTSLoader.js";

it("exports the managed constructor API", () => {
  expectTypeOf<GLTSInstance>().toExtend<THREE.Group>();
  expectTypeOf<GLTSInstance["ready"]>().toEqualTypeOf<Promise<void>>();
  expectTypeOf<InstanceType<GLTSConstructor>>().toEqualTypeOf<GLTSInstance>();
  expectTypeOf<GLTSLoader["loadAsyncConstructor"]>()
    .returns.toEqualTypeOf<Promise<GLTSConstructor>>();
});
