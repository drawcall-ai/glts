import { BatchedMesh, InstancedMesh, Line, Mesh, Points, Sprite, Texture, type Object3D } from "three/webgpu";

/**
 * Disposes, each once, the geometries, materials, and material textures of the meshes, lines, points, and sprites in
 * `root`'s subtree, and the instanced and batched meshes' own buffers. Textures reached only through node graphs or
 * uniforms are not freed.
 */
export function disposeTree(root: Object3D): void {
  const resources = new Set<{ dispose(): void }>();
  root.traverse((node) => {
    if (node instanceof InstancedMesh || node instanceof BatchedMesh) resources.add(node);
    if (!(node instanceof Mesh || node instanceof Line || node instanceof Points || node instanceof Sprite)) return;
    // A batched mesh disposes its own geometry, and every sprite shares one geometry.
    if (!(node instanceof BatchedMesh || node instanceof Sprite)) resources.add(node.geometry);
    for (const material of [node.material].flat()) {
      resources.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}
