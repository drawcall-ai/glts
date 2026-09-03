# GLTS

**Like glTF, but for procedural Three.js assets.**

GLTS loads trusted, exportless TypeScript scripts into addable Three.js groups.
Scripts build scenes with ordinary Three.js APIs and can compose other GLTS
assets explicitly through a contextual loader.

```ts
import * as THREE from "three"
import { onDispose, scene } from "@drawcall/glts"

const geometry = new THREE.IcosahedronGeometry()
const material = new THREE.MeshStandardMaterial({ color: "orange" })
scene.add(new THREE.Mesh(geometry, material))

onDispose(() => {
  geometry.dispose()
  material.dispose()
})
```

GLTS is executable code, not a sandbox or serialization format. Only load code
you trust.

## Load a scene

Install GLTS next to the application's Three.js dependency:

```sh
pnpm add @drawcall/glts three
```

```ts
import { GLTSLoader } from "@drawcall/glts"
import * as THREE from "three"

const loadingManager = new THREE.LoadingManager()
const loader = new GLTSLoader(loadingManager)
const tree = await loader.loadAsync("/assets/tree.glts")

scene.add(tree)
tree.update(deltaSeconds)

await tree.reload()
tree.dispose()
loader.dispose()
```

The result is a stable `THREE.Group` with four additions:

- `url`: canonical source URL;
- `reload()`: executes the latest source while preserving group identity;
- `update(delta)`: dispatches registered frame callbacks;
- `dispose()`: releases this scene and its nested GLTS scenes.

`clone()` remains the ordinary Three.js clone operation and produces an
unmanaged snapshot.

`load()` has the familiar Three.js callback shape. `load()`, `loadAsync()`,
`loadInstancesAsync()`, and `reload()` accept strings or `URL` objects. Track
aggregate progress with `loadingManager.onProgress`; per-load progress callbacks
are rejected because nested GLTS and resource requests form one manager-owned
loading graph.

## Compose scripts

Scripts do not import other `.glts` files statically. They use the contextual
`gltsLoader` instance:

```ts
import { gltsLoader, scene } from "@drawcall/glts"

const branch = await gltsLoader.loadAsync(
  new URL("./branch.glts", import.meta.url),
)
scene.add(branch)
```

Every nested result must be added to the current script's `scene` before the
script finishes. Unattached results fail the parent load and are disposed.

The host creates an execution-scoped recursive loader backed by the same module
cache, lifecycle, live-node registry, and host loading manager. The scope makes
nested ownership unambiguous when scripts execute concurrently. Explicit `URL`
construction keeps relative resolution correct; `.href` is not needed by GLTS
methods.

## Script context

The supported runtime imports are:

```ts
import {
  gltsLoader,
  instanceCount,
  loadingManager,
  onDispose,
  onFrame,
  onMatrixUpdateAt,
  isPreview,
  scene,
} from "@drawcall/glts"
```

GLTS rewrites these imports for each execution. `scene`, counts, flags, and
callbacks never leak between concurrently executing scripts.

Scripts may use top-level `await`. Work started during script evaluation
through Three.js loaders using the contextual `loadingManager` is included in
that script's completion, including work started without awaiting its promise.
Notifications are forwarded to the host manager without mixing failures
between concurrent scripts.

Host URL modifiers are respected. Extension handlers must be registered with
the contextual manager and constructed with it; host-bound handler instances
cannot be reused safely across concurrent script scopes.

### Frame updates and cleanup

```ts
let elapsed = 0
onFrame((delta) => {
  elapsed += delta
  mesh.rotation.y = elapsed
})

onDispose(() => {
  texture.dispose()
  geometry.dispose()
  material.dispose()
})
```

Updating a parent scene also updates managed descendants. GLTS calls disposal
callbacks in reverse registration order. It does not infer resource ownership.

### Preview content

Create preview-only cameras and lights directly in the authored scene:

```ts
if (isPreview) {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(4, 3, 6)
  scene.add(camera, new THREE.HemisphereLight(0xffffff, 0x444444, 2))
}
```

Use `new GLTSLoader(manager, { isPreview: true })` in a preview application.
Nested scripts receive `isPreview === false`, so their standalone preview setup
does not leak into a parent's preview. Camera selection is the preview
application's responsibility; a simple previewer can use the only camera in
the loaded scene and fall back when none exists.

## Load instances

The promoted instancing API mirrors Three.js naming:

```ts
const rocks = await loader.loadInstancesAsync("/assets/rock.glts", 1000)

const matrix = new THREE.Matrix4()
for (let index = 0; index < rocks.count; index += 1) {
  matrix.makeTranslation(index * 2, 0, 0)
  rocks.setMatrixAt(index, matrix)
}

scene.add(rocks)
```

`GLTSInstances` is a distinct addable group with immutable `count`,
`getMatrixAt()`, `setMatrixAt()`, `reload()`, `update()`, and `dispose()`.

Ordinary mesh scripts are automatically converted to `THREE.InstancedMesh`
objects. A script can implement native instancing when it needs special
handling:

```ts
import * as THREE from "three"
import {
  instanceCount,
  onDispose,
  onMatrixUpdateAt,
  scene,
} from "@drawcall/glts"

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

Registering `onMatrixUpdateAt` selects native instancing. Current matrices are
replayed at registration, and later outer `setMatrixAt()` calls are forwarded
immediately. The script executes once, whether GLTS uses native or automatic
instancing. Reload preserves count and matrices and may switch implementation.

Automatic instancing rejects animated, composed, skinned, already-instanced,
and other non-mesh renderable hierarchies. Such scripts must implement native
instancing instead of receiving an approximate result.

## Reload and errors

Reload builds the replacement before changing the live node. Fetch,
compilation, import, or execution failure leaves the current content mounted.
The node's identity and application-owned transform survive successful reload;
authored root metadata and render state refresh with the new revision.

`loader.reload(url)` updates every live node loaded from that URL. This is
useful for development servers that receive a changed source path.

Failures are `GLTSError` values with `url`, `phase`, and `cause`. GLTS reports
source and resource requests through the supplied Three.js loading manager.

## Script restrictions

A `.glts` file:

- exports nothing;
- imports contextual values by name from `@drawcall/glts`;
- cannot import or construct `GLTSLoader`;
- loads nested `.glts` files with `gltsLoader`;
- cannot call `gltsLoader.reload()`; reload is a host/live-node operation;
- may import `three`, Three.js addons, and browser-compatible npm packages;
- may not use dynamic imports, import attributes, or local helper modules.

`three` always resolves to the host application's exact namespace. Three.js
addons and bare npm packages are fetched through ESM.sh with `three` redirected
to that host namespace.

The page must allow CORS access to sources and dependencies and permit `blob:`
ES modules in its CSP.

## Workspace

```sh
pnpm install
pnpm dev
pnpm check
pnpm test:e2e
```

## Agent skill

Install the GLTS authoring guidance for your coding agent:

```sh
npx skills add drawcall-ai/glts --skill glts
```
