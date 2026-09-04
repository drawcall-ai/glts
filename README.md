# GLTS

**Like glTF, but for procedural Three.js assets.**

GLTS loads trusted, exportless TypeScript scripts into native Three.js scenes.
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

## Viewer

Run `pnpm dev` to open the example viewer. It accepts a trusted, self-contained
`.glts` file by drag and drop or file picker and includes a bundled multi-file
vintage racecar.

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

scene.add(tree) // A loaded scene is also an ordinary Object3D subtree.
tree.update(deltaSeconds)

await tree.reload()
tree.dispose()
loader.dispose()
```

The result is a stable `THREE.Scene` with six additions:

- `url`: canonical source URL;
- `reload()`: executes the latest source while preserving scene identity;
- `update(delta)`: dispatches registered frame callbacks;
- `dispose()`: releases this scene and its nested GLTS scenes;
- `defaultCamera`: optional authored camera used by `GLTSRenderer` when the host
  omits one;
- `rendering`: renderer settings used by `GLTSRenderer` when this scene is the
  render root.

Native scene properties such as `background`, `environment`, `fog`, and
`overrideMaterial` work directly. `clone()` remains the ordinary Three.js clone
operation and produces an unmanaged snapshot.

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

### Root presentation and preview staging

Scene properties and `rendering` describe this scene when it is the render root.
Use `isPreview` to gate staging that exists only for standalone inspection:

```ts
import * as THREE from "three"
import { isPreview, onDispose, scene } from "@drawcall/glts"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"

scene.defaultCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
scene.defaultCamera.position.set(4, 3, 6)
scene.defaultCamera.lookAt(0, 1, 0)

if (isPreview) {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(20),
    new THREE.MeshStandardMaterial({ color: "#333333" }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  const light = new THREE.DirectionalLight("white", 3)
  light.position.set(4, 6, 3)
  light.castShadow = true
  scene.background = new THREE.Color("#171b2b")
  scene.fog = new THREE.Fog("#171b2b", 8, 40)
  scene.add(light, light.target, floor)

  scene.rendering.shadows = true
  scene.rendering.toneMapping = THREE.ACESFilmicToneMapping
  scene.rendering.toneMappingExposure = 1.1
  scene.rendering.effects.push(({ height, width }) =>
    new UnrealBloomPass(new THREE.Vector2(width, height), 0.3, 0.4, 0.85),
  )

  onDispose(() => {
    light.dispose()
    floor.geometry.dispose()
    floor.material.dispose()
  })
}
```

Set `castShadow` on intrinsic meshes outside the preview block when they should
cast in any lighting setup; enabling renderer shadows alone creates none.

Use `new GLTSLoader(manager, { isPreview: true })` in a preview application.
Only loads initiated through that host loader can receive `isPreview === true`.
Every contextual nested load receives `false` at every depth, and keeps that
value across reloads, so standalone presentation cannot leak into composition.
An asset may recommend a camera through `scene.defaultCamera`. It need not be
added to the scene graph unless it depends on an authored parent. The preview
application decides whether to use it or supply another camera; GLTS never
searches the scene hierarchy for one.

`scene.rendering` describes the renderer state needed to present this root:

- `shadows`
- `localClippingEnabled`
- `toneMapping`
- `toneMappingExposure`
- `effects`, an array of factories returning Three.js post-processing `Pass`
  instances compatible with `WebGLRenderer.setEffects()`

Factories receive the selected `camera`, loaded `scene`, and initial
drawing-buffer `width` and `height`. The selected camera is the explicit host
camera, or `scene.defaultCamera` when the host omits one. Use the supplied scene
and camera for effects that need them. Do not add `RenderPass` or `OutputPass`:
GLTS renders the beauty pass and final output itself. The adapter owns and
disposes the returned passes. The optional third argument to `render()` is
forwarded to passes as their frame delta.

The physical renderer, WebGL context, canvas, output color space, shadow-map
filtering, viewport, camera selection and projection, controls, and frame loop
remain application-owned. A preview host opts into the rendering profile
explicitly:

```ts
import { GLTSLoader, GLTSRenderer } from "@drawcall/glts"
import * as THREE from "three"

const renderer = new THREE.WebGLRenderer({
  ...GLTSRenderer.parameters,
  canvas,
})
const gltsRenderer = new GLTSRenderer(renderer)
const loader = new GLTSLoader(manager, { isPreview: true })
const root = await loader.loadAsync("/asset.glts")

root.update(delta)
gltsRenderer.render(root, undefined, delta)

root.dispose()
gltsRenderer.dispose()
```

Omitting the camera uses `root.defaultCamera`; rendering fails if neither is
available. Passing a camera as the second argument always overrides the
authored default. `defaultCamera` is qualified because `render()` accepts a
competing camera argument; native scene properties have no competing argument.

One `GLTSRenderer` can render different root assets sequentially across frames
while reusing the same WebGL context. It applies each root's settings for that
call, then restores the host renderer's settings. It exclusively manages
`renderer.setEffects()` for its lifetime: create only one adapter per physical
renderer and do not call `setEffects()` elsewhere. Construct the WebGL renderer
with `GLTSRenderer.parameters` when effects are used; it selects the HDR output
buffer required by Three.js. GLTS cannot inspect how an existing renderer was
constructed.
V1 effects and HDR tone mapping require the default framebuffer, a full
viewport, and disabled scissor testing; render-target and split-viewport
pipelines remain application-owned.

Changing the camera rebuilds that root's passes. Call `release(scene)` before
disposing an effect-bearing scene if the adapter remains alive;
`GLTSRenderer.dispose()` releases every cached pass. XR is outside V1. If the
host reads `renderer.info`, set `info.autoReset = false` and reset it once per
frame because post-processing performs nested render calls.

For embedding, `renderer.render(asset, camera)` and custom pipelines still work
because the result is a native scene. They intentionally ignore
`asset.rendering`; only the root scene passed to `GLTSRenderer.render()` owns
presentation. A nested asset's background, environment, fog,
override material, default camera, and rendering profile do not override its
parent.

V1 intentionally targets Three.js WebGL post-processing. PMNDRS composers,
Three.js WebGPU/TSL, TypeGPU, and other custom pipelines can consume the native
scene directly, but are not translated into `scene.rendering`.

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

`GLTSInstances` is a distinct addable scene with immutable `count`,
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
authored root metadata, default camera, and render state refresh with the new
revision.

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
