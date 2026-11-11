import { expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";

import type { GLTSCluster } from "../src/index.js";
import { base, serve } from "./loader/fixture.js";

const url = `${base}asset.glts`;
const mesh = "new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())";
const instancedMesh = "new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1)";

/** A script adding `objects`, given as source, to its scene. */
function script(...objects: string[]): string {
  return `import * as THREE from "three";
    import { scene } from "@drawcall/glts";
    scene.add(${objects.join(", ")});`;
}

function instancedMeshes(node: THREE.Object3D): THREE.InstancedMesh[] {
  return node.children.filter((child) => child instanceof THREE.InstancedMesh);
}

function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined) throw new Error(`Expected one item, got ${items.length}`);
  return item;
}

it("forwards the host's instancing data to the asset's instanced objects", async () => {
  const library = { Crowd: class extends THREE.Object3D {
    instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(new THREE.Matrix4().elements), 16);
    instanceColor: THREE.InstancedBufferAttribute | null = null;
    override count = 1;
    boundingBox: THREE.Box3 | null = null;
    clusters: GLTSCluster[] | undefined;
    computeBoundingBox(): void {}
  } };
  const loader = serve({ "asset.glts": `import { Crowd } from "library";\n${script(instancedMesh, "new Crowd()")}` }, library);
  const node = await loader.loadInstancesAsync(url, 3);
  node.updateMatrixWorld();
  const [target, crowd] = node.children;
  if (!(target instanceof THREE.InstancedMesh) || !(crowd instanceof library.Crowd)) throw new Error("Missing targets");

  expect(target.instanceMatrix).toBe(node.instanceMatrix);
  expect(crowd.instanceMatrix).toBe(node.instanceMatrix);
  expect([target.count, crowd.count]).toEqual([3, 3]);

  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const clusters = [{ start: 0, count: 2, boundingBox: box }];
  node.count = 2;
  node.boundingBox = box;
  node.clusters = clusters;
  node.updateMatrixWorld();
  expect([target.count, crowd.count]).toEqual([2, 2]);
  expect(crowd.boundingBox).toBe(box);
  expect(Reflect.get(target, "clusters")).toBe(clusters);
  expect(crowd.clusters).toBe(clusters);
  expect(target.boundingSphere).toEqual(box.getBoundingSphere(new THREE.Sphere()));
});

it("forwards the host's colors as they are, rebuilding the targets once they appear", async () => {
  const node = await serve({ "asset.glts": script(instancedMesh) }).loadInstancesAsync(url, 2);
  const target = only(instancedMeshes(node));
  const disposed = vi.fn();
  target.addEventListener("dispose", disposed);
  node.updateMatrixWorld();
  node.setColorAt(1, new THREE.Color(0.5, 0.25, 0));
  node.updateMatrixWorld();
  expect(target.instanceColor).toBe(node.instanceColor);
  expect(disposed).toHaveBeenCalledOnce();
  expect(target.getColorAt(1, new THREE.Color())).toEqual(new THREE.Color(0.5, 0.25, 0));
  node.setColorAt(0, new THREE.Color(0, 0, 1));
  node.updateMatrixWorld();
  expect(disposed).toHaveBeenCalledOnce();
});

it("rebuilds InstancedMesh targets when the host replaces an attribute", async () => {
  const node = await serve({ "asset.glts": script(instancedMesh) }).loadInstancesAsync(url, 2);
  const target = only(instancedMeshes(node));
  const disposed = vi.fn();
  target.addEventListener("dispose", disposed);

  node.updateMatrixWorld();
  const storage = new THREE.StorageInstancedBufferAttribute(8, 16);
  node.instanceMatrix = storage;
  node.updateMatrixWorld();
  expect(target.instanceMatrix).toBe(storage);
  expect(disposed).toHaveBeenCalledOnce();

  const cpu = new THREE.InstancedBufferAttribute(new Float32Array(16 * 8), 16);
  node.instanceMatrix = cpu;
  node.updateMatrixWorld();
  expect(target.instanceMatrix).toBe(cpu);
  expect(disposed).toHaveBeenCalledTimes(2);
});

it("addresses a storage instanceColor's 4 floats per instance", async () => {
  const node = await serve({ "asset.glts": script(instancedMesh) }).loadInstancesAsync(url, 2);
  const colors = new THREE.StorageInstancedBufferAttribute(2, 4);
  node.instanceColor = colors;
  node.setColorAt(1, new THREE.Color(0.5, 0.25, 0));
  expect([...colors.array]).toEqual([0, 0, 0, 0, 0.5, 0.25, 0, 0]);
  expect(node.getColorAt(1, new THREE.Color())).toEqual(new THREE.Color(0.5, 0.25, 0));
});

it("never culls targets of a storage instanceMatrix without a box", async () => {
  const node = await serve({ "asset.glts": script(instancedMesh) }).loadInstancesAsync(url, 2);
  node.instanceMatrix = new THREE.StorageInstancedBufferAttribute(2, 16);
  node.updateMatrixWorld();
  expect(only(instancedMeshes(node)).boundingSphere?.radius).toBe(Infinity);
});

it("throws while updating a count the instanceMatrix does not hold", async () => {
  const node = await serve({ "asset.glts": script(instancedMesh) }).loadInstancesAsync(url, 2);
  node.count = 3;
  expect(() => node.updateMatrixWorld()).toThrow("instance count must be an integer from 0 to instanceMatrix.count");
});

it("rejects instanced objects away from the asset's origin", async () => {
  const offset = `Object.assign(${instancedMesh}, { name: "crowd" }).translateX(1)`;
  const loader = serve({ "asset.glts": script(offset) });
  await expect(loader.loadInstancesAsync(url, 2)).rejects.toThrow("but crowd does not; move the offset into the child asset");
});

it("rejects instanced objects with copies of their own under loadInstancesAsync()", async () => {
  const many = `Object.assign(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 2), { name: "forest" })`;
  const moved = `Object.assign(${instancedMesh}, { name: "tree" }).setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 0, 0))`;
  const loader = serve({
    "many.glts": script(many),
    "moved.glts": script(moved),
    "empty.glts": script("new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 0)"),
    "nested.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadInstancesAsync("./child.glts", 2));`,
    "child.glts": script(mesh),
  });
  await expect(loader.loadInstancesAsync(`${base}many.glts`, 2)).rejects.toThrow("scatters its own copies with forest; load it with loadAsync()");
  await expect(loader.loadInstancesAsync(`${base}moved.glts`, 2)).rejects.toThrow("scatters its own copies with tree");
  await expect(loader.loadInstancesAsync(`${base}empty.glts`, 2)).resolves.toBeDefined();
  await expect(loader.loadInstancesAsync(`${base}nested.glts`, 2)).rejects.toThrow("scatters its own copies");
});

it("instances plain meshes from the host's instanceMatrix, with their transforms baked in", async () => {
  const placed = `new THREE.Group().add(Object.assign(${mesh}, { name: "box" }).translateX(2))`;
  const node = await serve({ "asset.glts": script(placed, instancedMesh) }).loadInstancesAsync(url, 2);
  const targets = instancedMeshes(node);
  expect(targets).toHaveLength(2);
  expect(node.children).toEqual(targets);
  const box = targets.find((target) => target.name === "box");
  node.updateMatrixWorld();
  expect(box?.instanceMatrix.array).toBe(node.instanceMatrix.array);
  expect(box?.matrix.equals(new THREE.Matrix4())).toBe(true);
  box?.geometry.computeBoundingBox();
  expect(box?.geometry.boundingBox?.min.x).toBe(1.5);

  node.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 10, 0));
  node.computeBoundingBox();
  expect(node.boundingBox?.max.toArray()).toEqual([2.5, 10.5, 0.5]);
  expect(box?.boundingBox).toBe(node.boundingBox);
});

it("rejects what automatic instancing cannot draw", async () => {
  const frames = `import * as THREE from "three";
    import { onFrame, scene } from "@drawcall/glts";
    scene.add(${mesh});
    onFrame(() => {});`;
  const loader = serve({
    "light.glts": script(mesh, "new THREE.PointLight()"),
    "frames.glts": frames,
    "nested.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./light.glts"));`,
  });
  await expect(loader.loadInstancesAsync(`${base}light.glts`, 2)).rejects.toThrow("does not support THREE.PointLight");
  await expect(loader.loadInstancesAsync(`${base}frames.glts`, 2)).rejects.toThrow("cannot use onFrame()");
  await expect(loader.loadInstancesAsync(`${base}nested.glts`, 2)).rejects.toThrow("load them with loadInstancesAsync(url, 1)");
});

it("forwards nothing to a scene loaded with loadAsync()", async () => {
  const forest = "new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 5).translateX(1)";
  const node = await serve({ "asset.glts": script(mesh, forest) }).loadAsync(url);
  const target = only(instancedMeshes(node));
  expect(target.count).toBe(5);
  expect(node.children.some((child) => child instanceof THREE.Mesh && !(child instanceof THREE.InstancedMesh))).toBe(true);
});

it("forwards a host's data through nested instances to their instanced objects", async () => {
  const loader = serve({
    "asset.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadInstancesAsync("./child.glts", 1));`,
    "child.glts": script(mesh),
  });
  const node = await loader.loadInstancesAsync(url, 3);
  node.updateMatrixWorld();
  const child = only(node.children);
  const target = only(instancedMeshes(child));
  expect(target.instanceMatrix).toBe(node.instanceMatrix);
  expect(target.count).toBe(3);
  // The CPU array holds the instances, so three bounds them from it.
  expect(target.boundingSphere).toBeNull();
});

it("keeps the host's data across a reload", async () => {
  const sources = { "asset.glts": script(instancedMesh) };
  const loader = serve(sources);
  const node = await loader.loadInstancesAsync(url, 3);
  const box = new THREE.Box3();
  node.count = 1;
  node.boundingBox = box;
  sources["asset.glts"] = script(mesh);
  await loader.reload(url);
  node.updateMatrixWorld();
  const target = only(instancedMeshes(node));
  expect(target.instanceMatrix).toBe(node.instanceMatrix);
  expect(target.count).toBe(1);
  expect(target.boundingBox).toBe(box);
});
