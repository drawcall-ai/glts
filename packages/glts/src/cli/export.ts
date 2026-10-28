import {
  DirectionalLight, InterpolateSmooth, Light, Material, MeshBasicMaterial, MeshStandardMaterial,
  PointLight, PropertyBinding, RGBAFormat, SkinnedMesh, Source, SpotLight, Sprite, Texture, UnsignedByteType,
  Object3D,
} from "three/webgpu";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { ImageData } from "@napi-rs/canvas";
import { requestAdapter } from "@drawcall/webgpu";
import type { GLTSScene } from "../types.js";
import { readBitmap } from "./bitmap.js";
import { writeHeadless } from "./headless.js";
import { Canvas } from "../headless/canvas.js";

export interface ExportOptions {
  output: string;
}

export async function exportFile(file: string, { output }: ExportOptions): Promise<void> {
  await writeHeadless(file, output, false, 1, exportScene);
}

class BlobReader {
  result: ArrayBuffer | undefined;
  onloadend: (() => void) | undefined;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
}

/** GLTFExporter uses browser globals; these adapters are installed only while exporting, and the returned function restores the originals. */
function installExportGlobals(): () => void {
  const globals = { document: undefined, OffscreenCanvas: Canvas, ImageData, FileReader: BlobReader };
  const descriptors = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}


/** Export the scene the script constructs and its explicit clips; frame callbacks and rendering settings are not baked. */
export async function exportScene(scene: GLTSScene): Promise<Uint8Array> {
  const materials = new Set<Material>();
  const visible = new Set<Object3D>();
  for (const child of scene.children) child.traverseVisible((object) => visible.add(object));
  for (const object of visible) {
    if (object instanceof Sprite || (object instanceof Light && !(object instanceof DirectionalLight || object instanceof PointLight || object instanceof SpotLight))) {
      throw new Error(`Cannot export ${object.type} "${object.name}" to GLB; keep preview-only objects inside isPreview.`);
    }
    if (object instanceof SkinnedMesh && object.skeleton.bones.some(bone => !visible.has(bone))) {
      throw new Error(`Cannot export skin "${object.name}": every skeleton bone must be visible and attached to the scene.`);
    }
    if (!("material" in object)) continue;
    if (object.material instanceof Material) materials.add(object.material);
    else if (Array.isArray(object.material)) {
      for (const value of object.material) {
        if (value instanceof Material) materials.add(value);
      }
    }
  }
  for (const clip of scene.animations) {
    for (const track of clip.tracks) {
      const binding = PropertyBinding.parseTrackName(track.name);
      const { propertyName } = binding;
      if (!["position", "quaternion", "scale", "morphTargetInfluences"].includes(propertyName)) {
        throw new Error(`Cannot export animation track "${track.name}"; GLB supports position, quaternion, scale, and morphTargetInfluences.`);
      }
      let target: object | null | undefined = PropertyBinding.findNode(scene, binding.nodeName);
      if (binding.objectName === "bones") {
        target = target instanceof SkinnedMesh && typeof binding.objectIndex === "string" ? target.skeleton.getBoneByName(binding.objectIndex) : undefined;
      }
      if (!(target instanceof Object3D) || !visible.has(target)) {
        throw new Error(`Cannot export animation track "${track.name}": target is missing or excluded from the GLB.`);
      }
      if (track.getInterpolation() === InterpolateSmooth || (binding.propertyIndex !== undefined && propertyName !== "morphTargetInfluences") || (binding.objectName !== undefined && binding.objectName !== "bones")) {
        throw new Error(`Cannot export animation track "${track.name}": unsupported interpolation or property binding.`);
      }
    }
  }
  const textures = new Set<Texture>();
  for (const material of materials) {
    if (!(material instanceof MeshBasicMaterial || material instanceof MeshStandardMaterial)) {
      throw new Error(`Cannot export ${material.type} material "${material.name}"; use MeshStandardMaterial, MeshPhysicalMaterial, or MeshBasicMaterial.`);
    }
    for (const value of Object.values(material)) {
      if (value instanceof Texture) textures.add(value);
    }
  }

  const originalSources = new Map<Texture, Source<unknown>>();
  let device: GPUDevice | undefined;
  const restore = installExportGlobals();
  try {
    for (const texture of textures) {
      const image: unknown = texture.image;
      if (typeof image !== "object" || image === null) continue;
      if ("data" in image && (texture.format !== RGBAFormat || texture.type !== UnsignedByteType)) {
        throw new Error(`Cannot export data texture "${texture.name}"; use unsigned-byte RGBA pixels.`);
      }
      let data: unknown = "data" in image ? image.data : undefined;
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
        if (!device) {
          const adapter = await requestAdapter();
          if (!adapter) throw new Error("WebGPU is unavailable for exporting bitmap textures.");
          device = await adapter.requestDevice();
        }
        data = await readBitmap(device, image);
      }
      if (data === undefined) continue;
      if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !("width" in image) || typeof image.width !== "number" || !("height" in image) || typeof image.height !== "number" || data.length !== image.width * image.height * 4) {
        throw new Error(`Cannot export texture "${texture.name}": invalid bitmap pixels.`);
      }
      // Exporter combines PBR maps with drawImage, which requires a drawable canvas.
      const canvas = new Canvas(image.width, image.height);
      canvas.getContext("2d").putImageData(new ImageData(Uint8ClampedArray.from(data), image.width, image.height), 0, 0);
      originalSources.set(texture, texture.source);
      texture.source = new Source(canvas);
    }
    const result = await new GLTFExporter().parseAsync(scene, { binary: true, animations: scene.animations });
    if (!(result instanceof ArrayBuffer)) throw new Error("GLTFExporter did not produce a binary GLB.");
    return new Uint8Array(result);
  } finally {
    device?.destroy();
    for (const [texture, source] of originalSources) texture.source = source;
    restore();
  }
}
