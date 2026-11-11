import * as THREE from "three";
import { expect, it, vi } from "vitest";

import { takeTargets } from "../../src/execution/targets.js";

const options = { nodes: new Set<THREE.Object3D>(), frames: false, url: "https://example.test/asset.glts" };

function box(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
}

it("keeps a hidden ancestor's visibility on instanced objects it moves to the root", () => {
  const scene = new THREE.Scene();
  const hidden = new THREE.Group();
  hidden.visible = false;
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
  scene.add(hidden.add(crowd), box());
  takeTargets(scene, options);
  expect(crowd.parent).toBe(scene);
  expect(crowd.visible).toBe(false);
});

it("attempts every automatic instance disposal after one fails", () => {
  const scene = new THREE.Scene();
  scene.add(box(), box());
  const { targets, dispose } = takeTargets(scene, options);
  const [first, second] = targets;
  if (!first || !second) throw new Error("Expected two targets");
  vi.spyOn(first, "dispose").mockImplementation(() => { throw new Error("first failed"); });
  const disposed = vi.spyOn(second, "dispose");
  expect(dispose).toThrow("Automatic instance disposal failed");
  expect(disposed).toHaveBeenCalledOnce();
});

it("keeps a mirrored mesh's triangles facing out", () => {
  const scene = new THREE.Scene();
  const mirrored = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  mirrored.scale.x = -1;
  scene.add(mirrored);
  const { targets } = takeTargets(scene, options);
  const target = targets[0];
  if (!(target instanceof THREE.Mesh)) throw new Error("Expected a mesh");
  const geometry: THREE.BufferGeometry = target.geometry;
  geometry.computeVertexNormals();
  expect(geometry.getAttribute("normal").getZ(0)).toBeCloseTo(1);
});

it("rejects a mesh below an InstancedMesh, which would draw once", () => {
  for (const child of [box(), new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1)]) {
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
    crowd.name = "crowd";
    const scene = new THREE.Scene().add(crowd.add(child));
    expect(() => takeTargets(scene, options)).toThrow(`crowd has a mesh below it, a THREE.${child.type}, which would draw once`);
  }
});
