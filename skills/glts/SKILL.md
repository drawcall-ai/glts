---
name: glts
description: Author and review trusted procedural Three.js `.glts` scripts. Use for GLTS assets with resources, composition, instancing, animation, preview content, reload, or disposal; not for host applications that construct GLTSLoader.
---

# GLTS authoring

Build each asset by adding ordinary Three.js objects to the contextual `scene`.
A `.glts` file is an exportless TypeScript ESM script, not a class or factory:

```ts
import * as THREE from "three"
import { onDispose, scene } from "@drawcall/glts"

const geometry = new THREE.BoxGeometry()
const material = new THREE.MeshStandardMaterial()
scene.add(new THREE.Mesh(geometry, material))

onDispose(() => {
  geometry.dispose()
  material.dispose()
})
```

The only contextual imports are `gltsLoader`, `instanceCount`, `isPreview`,
`loadingManager`, `onDispose`, `onFrame`, `onMatrixUpdateAt`, and `scene`.
Runtime values from `@drawcall/glts` must use named imports; default and
namespace runtime imports are errors. Type-only imports are allowed, but
`GLTSLoader` cannot be imported as a runtime value. Any export declaration is
an error, including `export type` and `export interface`.

## What a script may import

Scripts may import `three`, `three/addons/*`, and browser-compatible npm
packages. Addons and packages load through the configured CDN. Static `.glts`
imports, dynamic `import()`, import attributes, and local modules such as
`./shared.ts` are rejected; keep each script self-contained.

`import.meta.url` is rewritten to the script's own source URL, so
`new URL("./thing.png", import.meta.url)` resolves against the `.glts` file and
not against the blob module the runtime actually executes.

## Resources and cleanup

Pass the contextual `loadingManager` to Three.js loaders during script
evaluation. GLTS waits for every request reported through it before that script
resolves, including loads whose promise was not awaited, and forwards progress
to the host manager. Top-level `await` is supported. Do not start new resource
loads later from `onFrame`.

If the asset needs a LoadingManager extension handler, construct the handler
with the contextual manager and register it there. Host-bound handler instances
are deliberately not inherited because their requests cannot be scoped to this
script.

Three.js loaders take strings, so pass
`new URL("./bark.png", import.meta.url).href`. GLTS loader methods accept the
`URL` itself.

Release only what the script created. GLTS disposes nested managed nodes
recursively but never guesses ownership of geometries, materials, or textures.
Disposal callbacks run in reverse registration order.

Close disposal callbacks over the owned resources themselves. Do not discover
them by traversing `scene`: reload detaches the outgoing children before it runs
their disposal callbacks.

## Nested GLTS scenes

Use the contextual `gltsLoader`, which is scoped to the current execution while
sharing the host's runtime, module cache, and node registry. Resolve relative
paths explicitly:

```ts
import { gltsLoader, scene } from "@drawcall/glts"

const wheel = await gltsLoader.loadAsync(
  new URL("./wheel.glts", import.meta.url),
)
scene.add(wheel)
```

Add every loaded result to `scene` before the script finishes. This makes frame
updates and disposal recursive; leaving a nested result unattached is an error.
The contextual loader supports `loadAsync()` and `loadInstancesAsync()`, not
`reload()`; reloading the live graph is a host concern. Do not create cyclic
nested loads.

## Instancing

For an ordinary mesh hierarchy, the caller's `loadInstancesAsync(url, count)`
automatically converts each mesh to a `THREE.InstancedMesh`. Automatic
instancing is strict:

- any `Camera`, `Light`, `Line`, `Points`, `Sprite`, `LOD`, `SkinnedMesh`,
  `InstancedMesh`, or `BatchedMesh` in the hierarchy fails the load;
- morph targets fail the load, and at least one mesh is required;
- `onFrame` fails the load;
- any nested GLTS scene fails the load because child reloads could otherwise
  invalidate the generated batch.

Keep animation out of an instanceable asset and let the parent write poses with
`setMatrixAt()`. When the asset genuinely needs its own per-instance behavior,
opt into native instancing instead:

```ts
import * as THREE from "three"
import { instanceCount, onDispose, onMatrixUpdateAt, scene } from "@drawcall/glts"

const geometry = new THREE.BoxGeometry()
const material = new THREE.MeshStandardMaterial()
const mesh = new THREE.InstancedMesh(geometry, material, instanceCount)
scene.add(mesh)

onMatrixUpdateAt((index, matrix) => {
  mesh.setMatrixAt(index, matrix)
  mesh.instanceMatrix.needsUpdate = true
})

onDispose(() => {
  mesh.dispose()
  geometry.dispose()
  material.dispose()
})
```

Registering `onMatrixUpdateAt` selects native instancing, replays the current
matrices immediately, and receives every later outer `setMatrixAt()`. The script
still executes exactly once. `instanceCount` is `1` for a plain `loadAsync()`,
so a native-instancing script stays valid when loaded as a single scene.

Use `gltsLoader.loadInstancesAsync(url, count)` when a composed child should
itself be instanced.

## Frame updates

`onFrame((delta) => ...)` runs when the host calls `update(delta)` on the loaded
root; updating a root also updates its managed descendants.

Animate objects the script owns. The host owns the loaded root's transform, so
put script-controlled transforms on a child group rather than on `scene`.

## Reload

Reload keeps the managed node's identity, host-owned transform, and outer
instance matrices. It replaces the children and refreshes authored root
metadata such as `scene.name`, `scene.userData`, visibility, layers, and render
settings.

The imported `scene` is a live binding that points at the stable node after
reload. Frame callbacks may reference `scene` directly, but do not capture it
under another variable: an alias would keep the temporary revision group
instead of following that binding. Disposal callbacks should close over owned
resources, as described above.

A failed reload leaves the current content mounted, so scripts do not need to
guard against partial replacement.

## Preview content

Add preview-only cameras and lights directly to `scene` when `isPreview` is
true:

```ts
import * as THREE from "three"
import { isPreview, scene } from "@drawcall/glts"

if (isPreview) {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(4, 3, 6)
  scene.add(camera, new THREE.HemisphereLight(0xffffff, 0x444444, 2))
}
```

Nested loads receive `isPreview === false`, so standalone preview content never
leaks into composition. A host `loadInstancesAsync()` uses its loader's preview
setting; preview-only cameras or lights make automatic instancing ineligible.
Camera selection remains the preview application's responsibility.
