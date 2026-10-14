import * as THREE from "three";
import type { Camera, Sphere } from "./views.js";

export function named(scene: THREE.Object3D, name: string): THREE.Object3D {
  const matches: THREE.Object3D[] = [];
  scene.traverse(object => { if (object.name === name) matches.push(object); });
  const [object] = matches;
  if (!object) throw new Error(`Unknown object "${name}".`);
  if (matches.length !== 1) throw new Error(`Ambiguous object "${name}": names must be unique.`);
  return object;
}

export function bounds(object: THREE.Object3D): THREE.Sphere {
  const box = new THREE.Box3().setFromObject(object, true);
  if (box.isEmpty()) throw new Error(`No geometry to frame in "${object.name || "scene"}"; use sphere focus for bones or empty groups.`);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius)) throw new Error("Scene bounds are not finite.");
  sphere.radius = Math.max(sphere.radius, 0.001);
  return sphere;
}

export function focusSphere(scene: THREE.Object3D, focus: string | Sphere | undefined, isolated?: THREE.Object3D): THREE.Sphere {
  if (typeof focus === "string") return bounds(named(scene, focus));
  if (focus) return new THREE.Sphere(new THREE.Vector3(...focus.center), focus.radius);
  return bounds(isolated ?? scene);
}

export function fitCamera(name: Camera, sphere: THREE.Sphere): THREE.Camera {
  const { center, radius } = sphere;
  const direction = new THREE.Vector3();
  if (name === "persp") direction.set(1, 0.6, 1).normalize();
  else direction.setComponent("xyz".indexOf(name.charAt(1)), name.startsWith("+") ? 1 : -1);
  const half = radius * 1.12;
  const camera = name === "persp"
    ? new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 1000)
    : new THREE.OrthographicCamera(-half, half, half, -half, radius / 100, radius * 1000);
  if (name === "+y" || name === "-y") camera.up.set(0, 0, name === "+y" ? -1 : 1);
  const distance = name === "persp" ? half / Math.sin(THREE.MathUtils.degToRad(17.5)) : radius * 5;
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  return camera;
}

export function isolate(scene: THREE.Object3D, selected: THREE.Object3D): () => void {
  const keep = new Set<THREE.Object3D>();
  selected.traverse(object => keep.add(object));
  scene.traverse(object => { if (object instanceof THREE.Light) keep.add(object); });
  const masks = new Map<THREE.Object3D, number>();
  scene.traverse(object => {
    masks.set(object, object.layers.mask);
    // Layer filtering suppresses ancestor geometry while still traversing its children.
    if (!keep.has(object)) object.layers.mask = 0;
  });
  return () => { for (const [object, mask] of masks) object.layers.mask = mask; };
}
