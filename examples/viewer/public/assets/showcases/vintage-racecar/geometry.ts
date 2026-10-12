import * as THREE from "three"

function attribute(
  geometry: THREE.BufferGeometry,
  name: string
): THREE.BufferAttribute {
  const value = geometry.getAttribute(name)
  if (!(value instanceof THREE.BufferAttribute)) {
    throw new TypeError(`Expected buffer attribute: ${name}`)
  }
  return value
}

/** Merges non-indexed copies of `parts` into one geometry and disposes the parts. */
export function merge(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part))
  const total = flat.reduce((sum, part) => sum + attribute(part, "position").count, 0)
  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const uvs = new Float32Array(total * 2)
  let offset = 0
  for (const part of flat) {
    const position = attribute(part, "position")
    positions.set(position.array, offset * 3)
    normals.set(attribute(part, "normal").array, offset * 3)
    if (part.hasAttribute("uv")) {
      uvs.set(attribute(part, "uv").array, offset * 2)
    }
    offset += position.count
  }

  for (const part of new Set([...parts, ...flat])) part.dispose()

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2))
  return geometry
}
