import { GLTSLoader, GLTSRenderer, GLTSUSDExporter } from "@drawcall/glts";
import {
  ArrayCamera,
  Group,
  HalfFloatType,
  InstancedMesh,
  LoadingManager,
  Matrix4,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector4,
  WebGLRenderTarget,
  WebGLRenderer
} from "three";

async function physicsModule() {
  return import("@drawcall/physics");
}

function readErrorField(error: unknown, key: PropertyKey): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

declare global {
  interface Window {
    readonly ArrayCamera: typeof ArrayCamera;
    readonly GLTSLoader: typeof GLTSLoader;
    readonly GLTSUSDExporter: typeof GLTSUSDExporter;
    readonly physicsModule: typeof physicsModule;
    readonly GLTSRenderer: typeof GLTSRenderer;
    readonly Group: typeof Group;
    readonly HalfFloatType: typeof HalfFloatType;
    readonly InstancedMesh: typeof InstancedMesh;
    readonly LoadingManager: typeof LoadingManager;
    readonly Matrix4: typeof Matrix4;
    readonly PerspectiveCamera: typeof PerspectiveCamera;
    readonly Scene: typeof Scene;
    readonly Sphere: typeof Sphere;
    readonly Vector4: typeof Vector4;
    readonly WebGLRenderTarget: typeof WebGLRenderTarget;
    readonly WebGLRenderer: typeof WebGLRenderer;
    readonly readErrorField: typeof readErrorField;
  }
}

Object.defineProperties(window, {
  ArrayCamera: { value: ArrayCamera },
  GLTSLoader: { value: GLTSLoader },
  GLTSRenderer: { value: GLTSRenderer },
  GLTSUSDExporter: { value: GLTSUSDExporter },
  physicsModule: { value: physicsModule },
  Group: { value: Group },
  HalfFloatType: { value: HalfFloatType },
  InstancedMesh: { value: InstancedMesh },
  LoadingManager: { value: LoadingManager },
  Matrix4: { value: Matrix4 },
  PerspectiveCamera: { value: PerspectiveCamera },
  Scene: { value: Scene },
  Sphere: { value: Sphere },
  Vector4: { value: Vector4 },
  WebGLRenderTarget: { value: WebGLRenderTarget },
  WebGLRenderer: { value: WebGLRenderer },
  readErrorField: { value: readErrorField }
});
