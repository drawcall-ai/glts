import { GLTSLoader } from "@drawcall/glts";
import { Group, InstancedMesh, LoadingManager, Matrix4, Sphere } from "three";

function readErrorField(error: unknown, key: PropertyKey): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

declare global {
  interface Window {
    readonly GLTSLoader: typeof GLTSLoader;
    readonly Group: typeof Group;
    readonly InstancedMesh: typeof InstancedMesh;
    readonly LoadingManager: typeof LoadingManager;
    readonly Matrix4: typeof Matrix4;
    readonly Sphere: typeof Sphere;
    readonly readErrorField: typeof readErrorField;
  }
}

Object.defineProperties(window, {
  GLTSLoader: { value: GLTSLoader },
  Group: { value: Group },
  InstancedMesh: { value: InstancedMesh },
  LoadingManager: { value: LoadingManager },
  Matrix4: { value: Matrix4 },
  Sphere: { value: Sphere },
  readErrorField: { value: readErrorField }
});
