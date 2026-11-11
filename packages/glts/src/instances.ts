import * as THREE from "three/webgpu";

import { GLTSError } from "./errors.js";
import type { GLTSCluster, InstancedObject } from "./types.js";

/** What InstancedMesh targets cull by when nothing bounds a storage `instanceMatrix`: never culled. */
const unbounded = new THREE.Sphere(new THREE.Vector3(), Infinity);
const white = new THREE.Color(1, 1, 1);

function isStorage(attribute: THREE.InstancedBufferAttribute): boolean {
  return attribute instanceof THREE.StorageInstancedBufferAttribute;
}

/** Throws unless `attribute` holds one of `itemSizes` floats per instance in a Float32Array. */
function assertLayout(attribute: THREE.InstancedBufferAttribute, name: string, itemSizes: readonly number[]): void {
  if (!itemSizes.includes(attribute.itemSize) || !(attribute.array instanceof Float32Array)) {
    throw new TypeError(`GLTS ${name} must hold ${itemSizes.join(" or ")} floats per instance in a Float32Array`);
  }
}

/**
 * The instancing data a node holds for its host, as an InstancedMesh holds it, and forwards unchanged to its targets:
 * the instanced objects at its asset's origin. Above the uniform buffer limit, three uploads a CPU attribute once for
 * every InstancedMesh drawing it; below the limit, each InstancedMesh uploads its own uniform copy. A reload attaches
 * the new execution's targets to the same data.
 */
export class Instances {
  #matrix: THREE.InstancedBufferAttribute;
  #color: THREE.InstancedBufferAttribute | null = null;
  /** The `instanceMatrix` version the culling spheres were last set for. */
  #version = -1;
  #count: number;
  #box: THREE.Box3 | null = null;
  #clusters: GLTSCluster[] | undefined;
  readonly #sphere = new THREE.Sphere();
  #targets: readonly InstancedObject[] = [];
  /** Whether the spheres InstancedMesh targets cull by may no longer fit. */
  #stale = true;
  /** Whether `boundingSphere` was set to null, so its next read computes the box, as three computes a null sphere. */
  #recompute = false;
  #warned = false;
  #disposed = false;
  readonly #url: string;

  /** `count` instances at the origin, of the node loaded from `url`. */
  constructor(count: number, url: string) {
    this.#url = url;
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
    const identity = new THREE.Matrix4();
    for (let index = 0; index < count; index += 1) identity.toArray(matrix.array, index * 16);
    this.#matrix = matrix;
    this.#count = count;
  }

  get instanceMatrix(): THREE.InstancedBufferAttribute {
    return this.#matrix;
  }

  set instanceMatrix(value: THREE.InstancedBufferAttribute) {
    this.#assertUndisposed();
    assertLayout(value, "instanceMatrix", [16]);
    this.#matrix = value;
    this.#replace();
  }

  get instanceColor(): THREE.InstancedBufferAttribute | null {
    return this.#color;
  }

  set instanceColor(value: THREE.InstancedBufferAttribute | null) {
    this.#assertUndisposed();
    // InstancedMesh holds 3 floats per color; WGSL storage pads a color to 4, as three would by swapping the array.
    if (value) assertLayout(value, "instanceColor", isStorage(value) ? [4] : [3]);
    this.#color = value;
    this.#replace();
  }

  get count(): number {
    return this.#count;
  }

  set count(value: number) {
    this.#assertUndisposed();
    this.#count = value;
    this.#stale = true;
    for (const target of this.#targets) target.count = value;
  }

  get boundingBox(): THREE.Box3 | null {
    return this.#box;
  }

  set boundingBox(value: THREE.Box3 | null) {
    this.#assertUndisposed();
    this.#box = value;
    this.#stale = true;
    for (const target of this.#targets) target.boundingBox = value;
  }

  /** The sphere around `boundingBox`. */
  get boundingSphere(): THREE.Sphere | null {
    if (this.#recompute) this.computeBoundingBox();
    return this.#box && this.#box.getBoundingSphere(this.#sphere);
  }

  set boundingSphere(value: THREE.Sphere | null) {
    this.#assertUndisposed();
    if (value) throw new TypeError("GLTS boundingSphere follows boundingBox; set boundingBox, or null to compute it");
    this.#recompute = true;
    this.#stale = true;
  }

  get clusters(): GLTSCluster[] | undefined {
    return this.#clusters;
  }

  set clusters(value: GLTSCluster[] | undefined) {
    this.#assertUndisposed();
    this.#clusters = value;
    for (const target of this.#targets) target.clusters = value;
  }

  /** Forwards the data to `targets`, the instanced objects of the node's current execution. */
  attach(targets: readonly InstancedObject[]): void {
    this.#targets = targets;
    for (const target of targets) {
      target.instanceMatrix = this.#matrix;
      target.instanceColor = this.#color;
      target.count = this.#count;
      target.boundingBox = this.#box;
      target.clusters = this.#clusters;
    }
    this.#stale = true;
  }

  /**
   * Bounds the targets for culling by the host's edits, before the renderer projects them; throws for a `count` out of
   * range. A disposed node still in a scene does nothing.
   */
  sync(): void {
    if (this.#disposed) return;
    const count = this.#count;
    const max = this.#matrix.count;
    if (!Number.isSafeInteger(count) || count < 0 || count > max) {
      throw new RangeError(`GLTS instance count must be an integer from 0 to instanceMatrix.count, ${max}, not ${count}`);
    }
    const moved = this.#matrix.version !== this.#version;
    this.#version = this.#matrix.version;
    this.#cull(moved || this.#stale);
    this.#stale = false;
  }

  /**
   * Bounds the instances by each target's own bounds over them: an InstancedMesh's geometry at each matrix of the
   * CPU array, as InstancedMesh.computeBoundingBox() does.
   */
  computeBoundingBox(): void {
    this.#assertUndisposed();
    this.#recompute = false;
    const box = this.#box ?? new THREE.Box3();
    box.makeEmpty();
    this.boundingBox = null;
    for (const target of this.#targets) {
      target.computeBoundingBox();
      if (!target.boundingBox) throw new TypeError("GLTS instanced object's computeBoundingBox() did not set its boundingBox");
      box.union(target.boundingBox);
    }
    this.boundingBox = box;
  }

  /** Computes `boundingBox`, which `boundingSphere` surrounds. */
  computeBoundingSphere(): void {
    this.computeBoundingBox();
  }

  getMatrixAt(index: number, matrix: THREE.Matrix4): THREE.Matrix4 {
    return matrix.fromArray(this.instanceMatrix.array, index * 16);
  }

  setMatrixAt(index: number, matrix: THREE.Matrix4): void {
    this.#assertUndisposed();
    matrix.toArray(this.instanceMatrix.array, index * 16);
  }

  getColorAt(index: number, color: THREE.Color): THREE.Color {
    const colors = this.instanceColor;
    return colors ? color.fromArray(colors.array, index * colors.itemSize) : color.copy(white);
  }

  setColorAt(index: number, color: THREE.Color): void {
    this.#assertUndisposed();
    const colors = this.instanceColor
      ?? (this.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.instanceMatrix.count * 3).fill(1), 3));
    color.toArray(colors.array, index * colors.itemSize);
  }

  /** Makes later edits throw, as the node no longer draws them. */
  dispose(): void {
    this.#disposed = true;
  }

  #replace(): void {
    for (const target of this.#targets) {
      target.instanceMatrix = this.#matrix;
      target.instanceColor = this.#color;
      // Three builds an InstancedMesh's attributes into its shaders, which only a release of its render objects
      // rebuilds; replacing the mesh instead would leave the script's references to it stale. Every listener of its
      // `dispose` event receives this one, and three's previous-frame matrices for velocity, kept per mesh at the old
      // attribute's size, throw a RangeError on every velocity render once the attribute grows.
      if (target instanceof THREE.InstancedMesh) target.dispatchEvent({ type: "dispose" });
    }
    this.#stale = true;
  }

  /** Sets the spheres InstancedMesh targets cull by; `stale` when they may no longer fit the instances. */
  #cull(stale: boolean): void {
    // A set box is read again every frame, as hosts edit it in place.
    if (!stale && !this.#box) return;
    const sphere = this.boundingSphere ?? (isStorage(this.#matrix) ? unbounded : null);
    if (sphere === unbounded && !this.#warned) {
      this.#warned = true;
      console.warn("GLTS instances with a storage instanceMatrix and no boundingBox are never frustum culled; set boundingBox");
    }
    for (const target of this.#targets) {
      // A null sphere is computed again from the CPU array.
      if (target instanceof THREE.InstancedMesh) target.boundingSphere = sphere;
    }
  }

  #assertUndisposed(): void {
    if (this.#disposed) throw new GLTSError("GLTS node has been disposed", { phase: "dispose", url: this.#url });
  }
}
