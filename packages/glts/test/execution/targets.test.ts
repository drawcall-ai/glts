import * as THREE from "three";
import { expect, it, vi } from "vitest";

import { findTargets } from "../../src/execution/targets.js";

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
  findTargets(scene, options);
  expect(crowd.parent).toBe(scene);
  expect(crowd.visible).toBe(false);
});

it("attempts every automatic instance disposal after one fails", () => {
  const scene = new THREE.Scene();
  scene.add(box(), box());
  const { targets, dispose } = findTargets(scene, options);
  const [first, second] = targets;
  if (!first || !second) throw new Error("Expected two targets");
  vi.spyOn(first, "dispose").mockImplementation(() => { throw new Error("first failed"); });
  const disposed = vi.spyOn(second, "dispose");
  expect(dispose).toThrow("Automatic instance disposal failed");
  expect(disposed).toHaveBeenCalledOnce();
});
