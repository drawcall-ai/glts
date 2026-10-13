---
name: glts
description: Write and host GLTS procedural Three.js assets. Covers authoring `.glts` scripts (scene, resources, cleanup, helpers, composition, instancing, preview staging, rendering profile, reload safety) and using `@drawcall/glts` in an app (GLTSLoader and its options, instances, reload, errors, GLTSRenderer, sharing packages with `modules`, and the `@drawcall/glts/vite` plugin). Use when creating, editing, reviewing, loading, rendering, or hot reloading `.glts` files, or when configuring `@drawcall/glts` in a Three.js or Vite app.
---

# GLTS

A `.glts` file is a TypeScript ES module that builds a Three.js asset. `GLTSLoader` runs it and returns a native `THREE.Scene` with lifecycle methods. GLTS executes the script as code with no sandbox, so only load scripts you trust.

# Writing scripts

## Shape

Build the asset in the imported `scene`, a `THREE.Scene`. The file is a plain script, not a class or factory:

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

Import the context by name from `@drawcall/glts`. Each execution gets its own values:

| Import | Meaning |
| --- | --- |
| `scene` | The asset's root scene. |
| `onDispose(fn)` | Runs `fn` when this execution is disposed or replaced by a reload; reverse registration order. |
| `onFrame(fn)` | Runs `fn(delta)` when the host calls `update(delta)`. |
| `loadingManager` | The `LoadingManager` to pass to Three.js loaders. |
| `gltsLoader` | Loads nested `.glts` files (`loadAsync`, `loadInstancesAsync`). |
| `isPreview` | `true` only when a host preview loader's `loadAsync()` loaded this script directly; a node keeps its value across reloads. |
| `instanceCount` | Instance count; `1` for a plain `loadAsync()`. |
| `onMatrixUpdateAt(fn)` | Opts into native instancing (see Instancing). |

Rules:

- Export no values, and from `@drawcall/glts` import only the context names above; types are fine.
- Import `three`, `three/addons/*`, browser-compatible npm packages, full `https://` module URLs, or helpers (see Helpers).
- Never import `.glts` files statically, or other local files such as `./data.json`; never use dynamic `import()` or import attributes.
- Top-level `await` works.

## Scene and presentation

- Use native scene properties directly: `background`, `environment`, `fog`, `overrideMaterial`, and the normal `Object3D` API.
- The host owns the root transform. Put authored placement on a child group; never set `scene.position`, `rotation`, `quaternion`, `scale`, or `matrix`.
- Assign `scene.defaultCamera` when the asset has a useful view. The host may override it and sets its aspect; GLTS never changes camera projection or searches the hierarchy for cameras. Add it to the scene graph only if it depends on an authored parent.
- Do not create a renderer, canvas, resize handler, animation loop, controls, or `PMREMGenerator`. The app owns those.
- For image-based lighting, assign a correctly mapped `Texture` or `CubeTexture` to `scene.environment` and dispose it yourself.
- Visible shadows need all three: `scene.rendering.shadows = true`, `castShadow` on a shadow-capable light and on the casting meshes, and `receiveShadow` on receivers.

### Preview staging

Gate staging that exists only for standalone inspection (floor, light rig, background, fog, bloom) with `isPreview`. Keep intrinsic content unconditional, including each mesh's `castShadow`.

```ts
import * as THREE from "three"
import { isPreview, onDispose, scene } from "@drawcall/glts"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"

scene.defaultCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
scene.defaultCamera.position.set(4, 3, 6)
scene.defaultCamera.lookAt(0, 1, 0)

if (isPreview) {
  const light = new THREE.DirectionalLight("white", 3)
  light.position.set(4, 6, 3)
  light.castShadow = true
  scene.add(light, light.target)
  scene.background = new THREE.Color("#171b2b")

  scene.rendering.shadows = true
  scene.rendering.toneMapping = THREE.ACESFilmicToneMapping
  scene.rendering.effects.push(({ width, height }) =>
    new UnrealBloomPass(new THREE.Vector2(width, height), 0.3, 0.4, 0.85),
  )

  onDispose(() => light.dispose())
}
```

### Rendering profile

`scene.rendering` holds `shadows`, `localClippingEnabled`, `toneMapping`, `toneMappingExposure`, and `effects`. It applies only when this scene is the root passed to `GLTSRenderer.render()`.

- Set it during script evaluation, never from frame, matrix, timer, or event callbacks.
- `effects` is an array of synchronous factories `({ camera, scene, width, height }) => Pass`, returning a Three.js `Pass` compatible with `WebGLRenderer.setEffects()`. `camera` is the camera the host renders with; `width` and `height` are the initial drawing-buffer size.
- Return a fresh pass on every call. Factories run again when the camera or the factory list changes.
- Never add `RenderPass` or `OutputPass`; the renderer does both and rejects them.
- The renderer owns and disposes the passes.

When the asset is nested, its background, environment, fog, override material, default camera, and rendering profile are ignored; the outer root wins.

## Resources and cleanup

- Pass the contextual `loadingManager` to every Three.js loader during evaluation. GLTS waits for every request reported through it, including loads you did not await, and fails the load if one fails.
- Loading closes when evaluation finishes: never start loads from `onFrame`, `onMatrixUpdateAt`, effect factories, timers, or event callbacks.
- Three.js loaders resolve relative URLs against the page; resolve them against the script instead: `new URL("./bark.png", import.meta.url).href`.
- Register LoadingManager handlers (`addHandler`) on the contextual `loadingManager`, with handler loaders constructed with it. A handler registered only on the host's manager makes the load fail.
- Dispose only what the script created. GLTS does not infer ownership of geometry, materials, or textures.

## Helpers

Share code between scripts with helpers: `.ts` modules imported by a `./` or `../` path, extension included.

```ts
// parts/geometry.ts
import * as THREE from "three"

export function tube(radius: number, length: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, length, 24)
}
```

```ts
// parts/axle.glts
import * as THREE from "three"
import { onDispose, scene } from "@drawcall/glts"
import { tube } from "./geometry.ts"

const geometry = tube(0.03, 1.4)
const material = new THREE.MeshStandardMaterial()
scene.add(new THREE.Mesh(geometry, material))

onDispose(() => {
  geometry.dispose()
  material.dispose()
})
```

- A helper may export anything and import what a script can, including other helpers.
- Helpers cannot import runtime values from `@drawcall/glts`; types are fine. Pass what a helper needs, such as `loadingManager`, from the script.
- A helper has no `onDispose`. Return what it creates and dispose it in the script.
- Keep no module-level state in helpers; it outlives disposal and is not shared between scripts.
- `import.meta.url` in a helper is the helper's own URL.
- Cyclic helper imports fail.
- An asset is its `.glts` file plus the helpers and files it references. Copy them together.

## Composition

Load other assets with the contextual `gltsLoader`; relative URLs resolve against the script:

```ts
import { gltsLoader, scene } from "@drawcall/glts"

const wheel = await gltsLoader.loadAsync("./wheel.glts")
scene.add(wheel)
```

- Add every loaded result beneath `scene` before the script finishes; an unattached result fails the load.
- Attached results are disposed with their parent.
- Cyclic loads fail.

## Instancing

When the host calls `loadInstancesAsync(url, count)` on an ordinary mesh hierarchy, GLTS converts each mesh to a `THREE.InstancedMesh` automatically. The load fails if the hierarchy contains:

- a `Camera`, `Light`, `Line`, `Points`, `Sprite`, `LOD`, `SkinnedMesh`, `InstancedMesh`, or `BatchedMesh`;
- morph targets, or no mesh at all;
- an `onFrame` callback;
- a nested GLTS scene.

Keep instanceable assets static and let the parent pose instances with `setMatrixAt()`.

When the asset needs its own per-instance behavior, implement native instancing:

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

Registering `onMatrixUpdateAt` selects native instancing. It immediately replays the current matrices and then receives every later host `setMatrixAt()`. The script still runs once. Because `instanceCount` is `1` for `loadAsync()`, the script also works as a single scene.

## Reload safety

`scene` is a live binding that follows the stable node after a reload. Reference it directly in callbacks; never store it in another variable.

# Hosting scripts

## Loading

```ts
import { GLTSLoader } from "@drawcall/glts"
import * as THREE from "three"

const manager = new THREE.LoadingManager()
const loader = new GLTSLoader(manager)
const tree = await loader.loadAsync("/assets/tree.glts")
scene.add(tree)

tree.update(delta) // every frame
await loader.reload("/assets/tree.glts")
tree.dispose()
loader.dispose() // also disposes every scene it loaded
```

- `load()` (Three.js callback style), `loadAsync()`, `loadInstancesAsync()`, and `reload()` take a string or `URL`. Strings resolve against `loader.path` and then the page's `document.baseURI`; the manager's URL modifier applies. Without a page, pass absolute URLs.
- In Node.js 22.3 or later, load scripts from disk with `file:` URLs, such as `pathToFileURL("scene.glts")`; their helpers and nested scripts are read from disk too, and `reload()` re-reads them.
- Per-load progress callbacks are rejected. Track progress with `manager.onProgress`; nested scripts and their resources report through the same manager.
- `setRequestHeader()` and `setWithCredentials()` apply to script and package requests.
- Serve cross-origin scripts and packages with CORS, and allow `data:` ES modules in the page's CSP.

The result is a `GLTSScene` (a `THREE.Scene`) with:

| Member | Meaning |
| --- | --- |
| `url` | Resolved source URL. |
| `update(delta)` | Runs frame callbacks of this and nested GLTS scenes. |
| `dispose()` | Runs disposal callbacks, disposes nested GLTS scenes, and frees its `GLTSRenderer` passes. |
| `defaultCamera` | The asset's recommended camera, or `undefined`. |
| `rendering` | The rendering profile used by `GLTSRenderer`. |

`clone()` is the ordinary Three.js clone and returns an unmanaged copy.

Options, `new GLTSLoader(manager, options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `isPreview` | `false` | Value of `isPreview` for scripts this loader's `loadAsync()` loads directly. |
| `modules` | `{}` | Host packages scripts import instead of the CDN (see Packages). |
| `cdnURL` | `https://esm.sh/` | Where scripts' other packages come from. |
| `resolve` | none | Resolves bare imports to URLs the app imports natively, such as `import.meta.resolve` (see Packages). |

## Instances

```ts
const rocks = await loader.loadInstancesAsync("/assets/rock.glts", 1000)
const matrix = new THREE.Matrix4()
for (let index = 0; index < rocks.count; index += 1) {
  rocks.setMatrixAt(index, matrix.makeTranslation(index * 2, 0, 0))
}
scene.add(rocks)
```

The result is a `GLTSInstances` with a fixed `count`, `getMatrixAt(index, target)`, and `setMatrixAt(index, matrix)`, plus the scene members above.

## Reload and errors

- `loader.reload(url)` invalidates the cached source and reloads every undisposed node loaded from that URL; with none, it fetches nothing and the next load gets fresh source. Pending loads of that URL finish first. For a helper's URL, it does the same for every script that imports the helper, directly or through other helpers.
- A reload builds the replacement before touching the live node. Any failure leaves the current content in place.
- A reload keeps the node's identity, host transform, and instance matrices, and refreshes its root properties, `defaultCamera`, and `rendering`.
- A reload replaces the asset's children; look them up again instead of keeping references.
- Source requests use HTTP `no-cache`. Later loads of the same URL reuse the cached source until it is invalidated.
- Load and reload failures reject with `GLTSError`: `url`, `phase` (`resolve`, `fetch`, `transform`, `evaluate`, `construct`, `resource`, `reload`, `dispose`), `importChain`, and `cause`.
- Invalid arguments raise `RangeError`: `loadInstancesAsync()` rejects a count that is not a positive integer; `update()` throws on a negative or non-finite delta, and `getMatrixAt()`/`setMatrixAt()` on an out-of-range index.
- `dispose()` throws an `AggregateError` when disposal callbacks throw; the node is disposed anyway.

## Rendering with GLTSRenderer

Use `GLTSRenderer` when the asset's `rendering` profile and `defaultCamera` should apply, as in a preview app:

```ts
import { GLTSLoader, GLTSRenderer } from "@drawcall/glts"
import * as THREE from "three"

const renderer = new THREE.WebGLRenderer({ ...GLTSRenderer.parameters, canvas })
const gltsRenderer = new GLTSRenderer(renderer)
const loader = new GLTSLoader(manager, { isPreview: true })
const root = await loader.loadAsync("/asset.glts")

root.update(delta)
gltsRenderer.render(root, undefined, delta) // undefined: use root.defaultCamera

root.dispose()
gltsRenderer.dispose()
```

- `render(root, camera?, delta = 0)` renders with the root's profile and `camera`, else `root.defaultCamera`, and throws if neither exists; `delta` reaches the effect passes.
- Create one `GLTSRenderer` per `WebGLRenderer` (a second throws) and never call `setEffects()` elsewhere.
- Construct the `WebGLRenderer` with `GLTSRenderer.parameters` when roots use effects.
- Effects and tone mapping need the default framebuffer, a full viewport, and scissor testing off.
- The app still owns the canvas, output color space, shadow-map type, viewport, camera projection, controls, and frame loop.
- `renderer.render(asset, camera)` and custom pipelines also work, because the asset is a native scene; they ignore `rendering`.

## Packages

- `three` in a script is always the app's own `three`.
- Without the Vite plugin, other bare imports load at runtime from `cdnURL` (esm.sh) and share the app's `three` and every `modules` entry; `three/addons/*` matches the app's Three.js version.
- `modules` gives scripts the app's own package instead. Keys match import specifiers exactly, so `simplex-noise@4` still comes from the CDN unless listed:

```ts
import * as simplexNoise from "simplex-noise"

const loader = new GLTSLoader(manager, { modules: { "simplex-noise": simplexNoise } })
```

Share every package whose objects the app must recognize (`instanceof` checks, registries, singletons); a CDN copy is a different instance whose objects the app won't recognize.

In Node.js, pass the app's `import.meta.resolve` as `resolve` to load every bare import from the app's `node_modules`, sharing the app's instances like the Vite plugin does. Imports with a version, such as `simplex-noise@4`, still come from the CDN, and a package the app cannot resolve fails the load:

```ts
const loader = new GLTSLoader(manager, { resolve: import.meta.resolve })
```

## Vite plugin

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { glts } from "@drawcall/glts/vite"

export default defineConfig({ plugins: [glts()] })
```

Needs `vite` 6 or later and Node.js 22.17 or later. It works on the `.glts` files in Vite's public directory, which the app loads by their served URL (for example `public/tree.glts` as `/tree.glts`).

- Every `GLTSLoader` in the app receives, as `modules`, the packages those scripts and their helpers import; the app's own `modules` entries take precedence.
- `three` and packages in the `dependencies` or `devDependencies` of the app's nearest `package.json` are the app's own instances.
- Other packages, and versioned imports such as `pkg@2`, are fetched from the CDN during development and builds and bundled with the app. Each package that scripts import or the app declares exists once.
- Every loader gets the plugin's `cdnURL` option (default `https://esm.sh/`) as its default `cdnURL`. Scripts outside the public directory and `https://` imports still load packages at runtime.
- Editing or creating a public script or helper hot reloads the nodes loaded from it; changing which packages scripts import reloads the page.

Type checking: the plugin type checks the public `.glts` files and their helpers strictly, independently of the app's `tsconfig.json`, using the app's `typescript` 5 or 6; install it as a dev dependency, or `vite build` fails.

- Type errors fail `vite build`. During development they print in the terminal and hot reload continues.
- Only installed packages are typed: CDN packages and `https://` imports are untyped and cannot be used as types. Imports used only as types are never fetched, so they need the package installed.

## Verify

When the project has a harness, load the asset with `new GLTSLoader(manager, { isPreview: true })`, call `update()` once and render with `GLTSRenderer`; if it sets `defaultCamera`, check both it and an explicit host camera. A successful load is not visual validation.
