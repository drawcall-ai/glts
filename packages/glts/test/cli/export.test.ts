import {
  AnimationClip, Bone, BoxGeometry, BufferAttribute, DataTexture, Float32BufferAttribute,
  LoadingManager, Mesh, MeshStandardMaterial, NumberKeyframeTrack, QuaternionKeyframeTrack, RGBAFormat,
  ShaderMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Canvas, Image, loadImage } from "@napi-rs/canvas";
import { afterEach, expect, it, vi } from "vitest";
import { exportScene } from "../../src/cli/export.js";
import { GLTSLoader } from "../../src/loader/index.js";

const loaders: GLTSLoader[] = [];
afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
  vi.unstubAllGlobals();
});

async function scene() {
  const loader = new GLTSLoader(new LoadingManager(), { isPreview: false });
  loaders.push(loader);
  return loader.loadAsync("data:text/plain,");
}

it("roundtrips a procedural skinned mesh, morph target and UUID-addressed animation", async () => {
  const asset = await scene();
  const geometry = new BoxGeometry();
  const positions = geometry.getAttribute("position");
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(new Uint16Array(positions.count * 4), 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(Array.from({ length: positions.count * 4 }, (_, index) => index % 4 === 0 ? 1 : 0), 4));
  geometry.morphAttributes.position = [new BufferAttribute(Float32Array.from(positions.array, (value) => value * 2), 3)];
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: "red" }));
  mesh.name = "dragon";
  const bone = new Bone();
  bone.name = "wing";
  mesh.add(bone);
  mesh.bind(new Skeleton([bone]));
  asset.add(mesh);
  const helper = new Mesh(new BoxGeometry(), new ShaderMaterial());
  helper.visible = false;
  asset.add(helper);
  const rotations = new Float32Array([0, 0, 0, 1, 0, 0, Math.sin(0.5), Math.cos(0.5)]);
  asset.animations.push(new AnimationClip("flap", 1, [new QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, [0, 1], rotations)]));

  const data = await exportScene(asset);
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(data).buffer, "");
  const output = gltf.scene.getObjectByName("dragon");
  if (!(output instanceof SkinnedMesh)) throw new Error("Missing exported skin");
  expect(output.geometry.getAttribute("position").count).toBe(positions.count);
  expect(Array.from(output.geometry.getAttribute("skinWeight").array)).toEqual(Array.from(geometry.getAttribute("skinWeight").array));
  expect(output.skeleton.bones.map((joint) => joint.name)).toEqual(["wing"]);
  expect(output.geometry.morphAttributes.position?.length).toBe(1);
  expect(gltf.animations.map((clip) => clip.name)).toEqual(["flap"]);
  expect(gltf.animations[0]?.tracks[0]?.values).toEqual(rotations);
  expect(mesh.material).toBeInstanceOf(MeshStandardMaterial);
  expect(mesh.skeleton.bones[0]).toBe(bone);
});

it("embeds PNG images from DataTexture and combines PBR maps without modifying originals", async () => {
  const asset = await scene();
  const pixels = new Uint8Array([255, 0, 0, 255]);
  const texture = new DataTexture(pixels, 1, 1, RGBAFormat);
  asset.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: texture })));
  asset.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({
    roughnessMap: new DataTexture(new Uint8Array([0, 64, 0, 255]), 1, 1),
    metalnessMap: new DataTexture(new Uint8Array([0, 0, 128, 255]), 1, 1),
  })));
  const originalSource = texture.source;
  const data = await exportScene(asset);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const json: unknown = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + view.getUint32(12, true))));
  expect(json).toMatchObject({ images: [{ mimeType: "image/png" }, { mimeType: "image/png" }] });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => loadImage(Buffer.from(await blob.arrayBuffer())));
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(data).buffer, "");
  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) return;
    const image: unknown = (object.material.map ?? object.material.roughnessMap)?.image;
    const canvas = new Canvas(1, 1);
    const context = canvas.getContext("2d");
    if (!(image instanceof Image)) throw new Error("Missing texture image");
    context.drawImage(image, 0, 0);
    expect(Array.from(context.getImageData(0, 0, 1, 1).data)).toEqual(object.material.map ? Array.from(pixels) : [0, 64, 128, 255]);
  });
  expect(texture.source).toBe(originalSource);
  expect(texture.image.data).toBe(pixels);
});

it("rejects unsupported materials and animation channels instead of producing an incomplete GLB", async () => {
  const asset = await scene();
  const mesh = new Mesh(new BoxGeometry(), new ShaderMaterial({ name: "dragon scales" }));
  asset.add(mesh);
  await expect(exportScene(asset)).rejects.toThrow('Cannot export ShaderMaterial material "dragon scales"');
  asset.remove(mesh);
  const standard = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  asset.add(standard);
  asset.animations.push(new AnimationClip("opacity", 1, [new NumberKeyframeTrack(`${standard.uuid}.visible`, [0, 1], [0, 1])]));
  await expect(exportScene(asset)).rejects.toThrow("Cannot export animation track");
  asset.animations = [new AnimationClip("missing", 1, [new QuaternionKeyframeTrack("missing.quaternion", [0], [0, 0, 0, 1])])];
  await expect(exportScene(asset)).rejects.toThrow("target is missing or excluded");
  asset.animations = [new AnimationClip("missing-bone", 1, [new QuaternionKeyframeTrack(`${standard.uuid}.bones[missing].quaternion`, [0], [0, 0, 0, 1])])];
  await expect(exportScene(asset)).rejects.toThrow("target is missing or excluded");
});
