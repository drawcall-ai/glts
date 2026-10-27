import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

import { getGLTSSource, GLTSLoader, GLTSRenderer } from "@drawcall/glts";
import {
  Group,
  InstancedMesh,
  LoadingManager,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Sphere,
  RenderTarget,
  WebGPURenderer
} from "three/webgpu";

function readErrorField(error: unknown, key: PropertyKey): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

declare global {
  interface Window {
    readonly bloom: typeof bloom;
    readonly getGLTSSource: typeof getGLTSSource;
    readonly GLTFLoader: typeof GLTFLoader;
    readonly GLTSLoader: typeof GLTSLoader;
    readonly GLTSRenderer: typeof GLTSRenderer;
    readonly Group: typeof Group;
    readonly InstancedMesh: typeof InstancedMesh;
    readonly LoadingManager: typeof LoadingManager;
    readonly Matrix4: typeof Matrix4;
    readonly OrthographicCamera: typeof OrthographicCamera;
    readonly PerspectiveCamera: typeof PerspectiveCamera;
    readonly Scene: typeof Scene;
    readonly Sphere: typeof Sphere;
    readonly RenderTarget: typeof RenderTarget;
    readonly WebGPURenderer: typeof WebGPURenderer;
    readonly readErrorField: typeof readErrorField;
  }
}

Object.defineProperties(window, {
  bloom: { value: bloom },
  getGLTSSource: { value: getGLTSSource },
  GLTFLoader: { value: GLTFLoader },
  GLTSLoader: { value: GLTSLoader },
  GLTSRenderer: { value: GLTSRenderer },
  Group: { value: Group },
  InstancedMesh: { value: InstancedMesh },
  LoadingManager: { value: LoadingManager },
  Matrix4: { value: Matrix4 },
  OrthographicCamera: { value: OrthographicCamera },
  PerspectiveCamera: { value: PerspectiveCamera },
  Scene: { value: Scene },
  Sphere: { value: Sphere },
  RenderTarget: { value: RenderTarget },
  WebGPURenderer: { value: WebGPURenderer },
  readErrorField: { value: readErrorField }
});
