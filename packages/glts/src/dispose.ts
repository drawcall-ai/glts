import { InstancedMesh, Line, Mesh, Points, Sprite, Texture, type Object3D } from "three/webgpu";

/**
 * Disposes, each once, the geometries and materials of the meshes, lines, points, and sprites in `root`'s subtree, the
 * textures those materials hold as properties, and instanced meshes themselves, which hold morph textures. Textures
 * reached only through node graphs or uniforms are not found.
 */
export function disposeTree(root: Object3D): void {
  const resources = new Set<{ dispose(): void }>();
  root.traverse((node) => {
    if (node instanceof InstancedMesh) resources.add(node);
    if (!(node instanceof Mesh || node instanceof Line || node instanceof Points || node instanceof Sprite)) return;
    resources.add(node.geometry);
    for (const material of [node.material].flat()) {
      resources.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}
