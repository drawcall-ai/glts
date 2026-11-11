import { expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";

import { disposeTree } from "../src/index.js";

it("disposes resources shared across a subtree's meshes once, including their materials' textures", () => {
  const geometry = new THREE.BoxGeometry();
  const map = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));
  root.add(new THREE.Group().add(new THREE.Mesh(geometry, [material, material])));
  const disposals = [geometry, material, map].map((resource) => vi.spyOn(resource, "dispose"));

  disposeTree(root);

  for (const disposal of disposals) expect(disposal).toHaveBeenCalledTimes(1);
});

it("lets batched meshes dispose their own geometry and keeps the geometry sprites share", () => {
  const batched = new THREE.BatchedMesh(1, 3, 3, new THREE.MeshBasicMaterial());
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
  const root = new THREE.Group().add(batched, sprite);
  const batchedDisposal = vi.spyOn(batched, "dispose");
  const batchedGeometryDisposal = vi.spyOn(batched.geometry, "dispose");
  const spriteMaterialDisposal = vi.spyOn(sprite.material, "dispose");
  const spriteGeometryDisposal = vi.spyOn(sprite.geometry, "dispose");

  disposeTree(root);

  expect(batchedDisposal).toHaveBeenCalledTimes(1);
  expect(batchedGeometryDisposal).toHaveBeenCalledTimes(1);
  expect(spriteMaterialDisposal).toHaveBeenCalledTimes(1);
  expect(spriteGeometryDisposal).not.toHaveBeenCalled();
});
