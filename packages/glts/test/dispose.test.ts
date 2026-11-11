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
