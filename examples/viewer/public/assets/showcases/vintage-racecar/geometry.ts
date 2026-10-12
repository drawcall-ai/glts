import type * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

/** Merges non-indexed copies of `parts` into one geometry and disposes the parts. */
export function merge(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part))
  const merged = mergeGeometries(flat)
  for (const part of new Set([...parts, ...flat])) part.dispose()
  if (!merged) throw new Error("Geometry parts need the same attributes")
  return merged
}
