import * as THREE from "three";
import { expect, it } from "vitest";

import { takeTargets } from "../../src/execution/targets.js";

const url = "https://example.test/asset.glts";

function box(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
}

it("keeps a hidden ancestor's visibility on instanced objects it moves to the root", () => {
  const scene = new THREE.Scene();
  const hidden = new THREE.Group();
  hidden.visible = false;
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
  scene.add(hidden.add(crowd), box());
  takeTargets(scene, [], false, url);
  expect(crowd.parent).toBe(scene);
  expect(crowd.visible).toBe(false);
});

it("keeps a mirrored mesh's triangles facing out", () => {
  const scene = new THREE.Scene();
  const mirrored = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  mirrored.scale.x = -1;
  scene.add(mirrored);
  const { targets } = takeTargets(scene, [], false, url);
  const target = targets[0];
  if (!(target instanceof THREE.Mesh)) throw new Error("Expected a mesh");
  const geometry: THREE.BufferGeometry = target.geometry;
  geometry.computeVertexNormals();
  expect(geometry.getAttribute("normal").getZ(0)).toBeCloseTo(1);
});

it("rejects children of an InstancedMesh, which would draw once", () => {
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
  crowd.name = "crowd";
  const scene = new THREE.Scene().add(crowd.add(new THREE.Group().add(box())));
  expect(() => takeTargets(scene, [], false, url)).toThrow("crowd has children, which would draw once");
});
