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
import * as THREE from "three/webgpu"
import { onDispose, scene } from "@drawcall/glts"

const geometry = new THREE.BoxGeometry()
const material = new THREE.MeshStandardMaterial()
scene.add(new THREE.Mesh(geometry, material))

onDispose(() => {
  geometry.dispose()
  material.dispose()
})
```

Import contextual bindings, the per-execution values and hooks such as `scene` and `onDispose`, by name from `@drawcall/glts`. Each script execution gets its own context.

Rules:

- Export no values. From `@drawcall/glts`, import only contextual bindings or types.
- Import `three/webgpu`, `three/tsl`, `three/addons/*`, browser-compatible npm packages, full `https://` module URLs, or helpers (see Helpers).
- Never import `.glts` files (load them with `gltsLoader.loadAsync()`) or other local files such as `./data.json`, and never use import attributes.
- Dynamic `import()` follows the same rules and resolves when it runs, so an import on a path that never runs is never fetched. `@drawcall/glts` must be imported statically. The Vite plugin bundles a literal specifier such as `import("pkg")` like a static import, loaded with the app; a computed one such as `import(name)` loads from the CDN.
- Top-level `await` works.

## Scene and presentation

- The host owns the root transform. Put authored placement on a child group; never set `scene.position`, `rotation`, `quaternion`, `scale`, or `matrix`.
- Assign `scene.defaultCamera` when the asset has a useful view. The host may override it; GLTSRenderer sizes its projection to the active viewport. GLTS never searches the hierarchy for cameras. Add it to the scene graph only if it depends on an authored parent.
- Do not create a renderer, canvas, resize handler, animation loop, controls, or `PMREMGenerator`. The app owns those.
- For image-based lighting, assign a correctly mapped `Texture` or `CubeTexture` to `scene.environment` and dispose it yourself.
- Visible shadows need all three: `scene.rendering.shadows = true`, `castShadow` on a shadow-capable light and on the casting meshes, and `receiveShadow` on receivers.

### Preview staging

Gate staging that exists only for standalone inspection (floor, light rig, background, fog, bloom) with `isPreview`. Keep intrinsic content unconditional, including each mesh's `castShadow`.

```ts
import * as THREE from "three/webgpu"
import { isPreview, onDispose, scene } from "@drawcall/glts"
import { bloom } from "three/addons/tsl/display/BloomNode.js"

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
  scene.rendering.effects.push(({ input }) =>
    input.add(bloom(input, 0.3, 0.4, 0.85)),
  )

  onDispose(() => light.dispose())
}
```

### Rendering profile

The rendering profile applies when this scene is the root passed to `GLTSRenderer`. Set it during script evaluation. Effect factories transform the incoming TSL color node; their outputs feed the next factory. Build fresh effect nodes each time, and let GLTS dispose the returned graph when the camera, effects, or scene changes. Keep script-owned geometry, materials, and textures in `onDispose`. Animate effect uniforms through `onFrame` when they should follow the asset's simulation time.

Use Three.js `ClippingGroup` for local clipping. For TSL composition and available effects, use the [Three.js TSL documentation](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language).

When the asset is nested, its background, environment, fog, override material, default camera, and rendering profile are ignored; the outer root wins.

## Resources and cleanup

- Use top-level `await` for asynchronous work the asset depends on, including resource loads and async helpers, so the script finishes with the asset ready. Prefer Three.js `loadAsync()`; use `await Promise.all(...)` for independent loads.
- Pass the contextual `loadingManager` to every Three.js loader during evaluation. It tracks resources but does not replace awaiting their completion; unawaited callbacks or background tasks can leave the asset unfinished when the script returns.
- Loading closes when evaluation finishes: never start loads from `onFrame`, `onMatrixUpdateAt`, effect factories, timers, or event callbacks.
- Three.js loaders resolve relative URLs against the page; resolve them against the script instead: `new URL("./bark.png", import.meta.url).href`.
- Register LoadingManager handlers (`addHandler`) on the contextual `loadingManager`, with handler loaders constructed with it. A handler registered only on the host's manager makes the load fail.
- Dispose only what the script created. GLTS does not infer ownership of geometry, materials, or textures.

## Helpers

Share code between scripts with helpers: `.ts` modules imported by a `./` or `../` path, extension included.

```ts
// parts/geometry.ts
import * as THREE from "three/webgpu"

export function tube(radius: number, length: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, length, 24)
}
```

```ts
// parts/axle.glts
import * as THREE from "three/webgpu"
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

- A helper may export anything and import what a script can, including other helpers, except that it imports only types from `@drawcall/glts`.
- Pass script bindings such as `scene`, `loadingManager`, and `scene.source` to helpers as arguments; a helper importing a value from `@drawcall/glts` fails to load.
- Return what a helper creates and dispose it in the script.
- Keep no module-level state in helpers: a loader runs each helper once, so its state is shared by every script the loader runs and outlives their disposal.
- `import.meta.url` in a helper is the helper's own URL.
- Static cyclic helper imports fail.
- An asset is its `.glts` file plus the helpers and files it references. Copy them together.

## Caching generated content

When expensive generation belongs to the asset, capture its code and package dependencies from contextual `scene.source`. It lists only what the script has used so far, so read it after loading generation inputs. Put query parameters and other generator arguments in a `{ value }` dependency. This avoids hand-maintained helper and package lists. For persistence, use the [vitecache skill](https://github.com/drawcall-ai/vitecache/blob/main/packages/vitecache/skills/vitecache/SKILL.md).

```ts
import { scene } from "@drawcall/glts"

const source = scene.source
const dependencies = {
  params: { value: Object.fromEntries(new URL(import.meta.url).searchParams) },
  source: { url: source.url },
  ...Object.fromEntries(source.dependencyUrls.map((url) => [`resource:${url}`, { url }])),
  ...Object.fromEntries(source.packages.map((name) => [`package:${name}`, { package: name }])),
  ...Object.fromEntries(Object.entries(source.moduleHashes).map(([url, hash]) => [`module:${url}`, { value: hash }])),
}
```

Prefer immutable versions for remote generators whose generated assets are cached: with a mutable range, a CDN content change silently invalidates every cached result.

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
- A failed nested load fails this script too, even when caught, so it cannot serve as an optional fallback.

## Instancing

Use automatic instancing for static mesh hierarchies and let the parent pose the instances. Choose native instancing for assets with their own per-instance behavior or nested GLTS scenes.

When the asset needs its own per-instance behavior, implement native instancing:

```ts
import * as THREE from "three/webgpu"
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
import * as THREE from "three/webgpu"

const manager = new THREE.LoadingManager()
const loader = new GLTSLoader(manager)
const tree = await loader.loadAsync("/assets/tree.glts")
scene.add(tree)

tree.update(delta) // every frame
await loader.reload("/assets/tree.glts")
tree.dispose()
loader.dispose() // also disposes every scene it loaded
```

- In Node.js, load scripts from disk with `file:` URLs, such as `pathToFileURL("scene.glts")`; their helpers and nested scripts are read from disk too, and `reload()` of an edited file re-reads it. Resources that scripts load with Three.js loaders go through the global `fetch`, which in Node.js does not read `file:` URLs; install one that does to load them from disk.
- Per-load progress callbacks are rejected. Track progress with `manager.onProgress`; nested scripts and their resources report through the same manager.
- Serve cross-origin scripts and packages with CORS, and allow `blob:` ES modules in the page's or worker's CSP.

The returned scene participates in ordinary Three.js composition. Advance it from the host's frame loop and dispose it when removed. Cloning creates an unmanaged Three.js scene.

For package resolution and shared namespaces, see Packages below. Use the loader's exported option types for configuration.

## Instances

```ts
const rocks = await loader.loadInstancesAsync("/assets/rock.glts", 1000)
const matrix = new THREE.Matrix4()
for (let index = 0; index < rocks.count; index += 1) {
  rocks.setMatrixAt(index, matrix.makeTranslation(index * 2, 0, 0))
}
scene.add(rocks)
```

## Reload and errors

- `loader.reload(url)` invalidates the cached source and reloads every undisposed node loaded from that file, including query variants; with none, it fetches nothing and the next load gets fresh source. Pending loads of that file finish first. For a helper's URL, it also re-reads the helpers importing it and does the same for every script that imports the helper, directly or through other helpers.
- A reload builds the replacement before touching the live node. Inspect the scene after a cleanup error, since the replacement may already be committed.
- A reload keeps the node's identity, host transform, and instance matrices, and refreshes its root properties, `defaultCamera`, and `rendering`.
- A reload replaces the asset's children; look them up again instead of keeping references.
- Source requests use HTTP `no-cache`. Loads of the same script file reuse its linked graph until it is invalidated, including across query variants such as `tree.glts?seed=1` and `tree.glts?seed=2`. Each load executes separately with its own query parameters in `import.meta.url`. The server sees only the first query's request for a script file until invalidation, so use parameters inside the script; a server that generates different source per query does not work with this sharing.
- Use the source location and import chain on `GLTSError` to find the failing asset or helper.

## Rendering with GLTSRenderer

Use `GLTSRenderer` when the asset's `rendering` profile and `defaultCamera` should apply, as in a preview app:

```ts
import { GLTSLoader, GLTSRenderer } from "@drawcall/glts"
import * as THREE from "three/webgpu"

const renderer = new THREE.WebGPURenderer({ canvas })
await renderer.init()
const gltsRenderer = new GLTSRenderer(renderer)
const loader = new GLTSLoader(manager, { isPreview: true })
const root = await loader.loadAsync("/asset.glts")

root.update(delta)
gltsRenderer.render(root) // uses root.defaultCamera

root.dispose()
gltsRenderer.dispose()
```

- Initialize the WebGPU renderer before wrapping it. A WebGL backend is rejected.
- Create one `GLTSRenderer` per renderer. The app owns the canvas, controls, viewport, and frame loop.
- Effects need the default framebuffer, a full viewport, and scissor testing off.
- Pass an explicit camera to override the asset's `defaultCamera`.
- Direct Three.js rendering and custom pipelines also work because the asset is a native scene; they ignore its rendering profile.

## Packages

- `three`, `three/webgpu`, and `three/tsl` always share the app's own namespaces.
- Without the Vite plugin, other bare imports load at runtime from `cdnURL` (esm.sh) and share the app's `three` and every `modules` entry; `three/addons/*` matches the app's Three.js version.
- `modules` gives scripts the app's own package instead. Keys match import specifiers exactly, so `simplex-noise@4` still comes from the CDN unless that exact key is listed. A listed versioned key also needs a `moduleSources` entry to report provenance; the Vite plugin supplies these:

```ts
import * as simplexNoise from "simplex-noise"

const loader = new GLTSLoader(manager, { modules: { "simplex-noise": simplexNoise } })
```

Share every package whose objects the app must recognize (`instanceof` checks, registries, singletons); a CDN copy is a different instance whose objects the app won't recognize.

For app-owned resources shared across assets, keep the helper's ordinary relative import in each script and supply a host namespace keyed by that helper's absolute URL. The helper still contributes its source and imported packages to provenance; its initialization is replaced by the host namespace. A shared resource the host already loaded is not requested by the script, so resolve its URL through the script's contextual `loadingManager` (`loadingManager.resolveURL(url)`) when handing it out; that records it in `scene.source`, and caches keyed on the source then see its changes. The app disposes shared resources after its assets, while a script disposes only resources it creates. This also lets the helper provide a local implementation for hosts that do not share one.

```ts
const loader = new GLTSLoader(manager, {
  modules: {
    [new URL("/content/textures.ts", location.href).href]: textureModule,
  },
})
```

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

It works on the `.glts` files in Vite's public directory, which the app loads by their served URL (for example `public/tree.glts` as `/tree.glts`).

- Public scripts avoid browser compilation; external scripts compile when loaded.
- Every `GLTSLoader` in the app receives, as `modules`, the packages those scripts and their helpers import; the app's own `modules` entries take precedence.
- `three` and packages in the `dependencies` or `devDependencies` of the app's nearest `package.json` are the app's own instances.
- Other packages, and versioned imports such as `pkg@2`, are fetched from the CDN during development and builds and bundled with the app. Each package that scripts import or the app declares exists once.
- Scripts outside the public directory and `https://` imports still load packages at runtime.
- Scripts and helpers receive [Vite's resolved environment variables](https://vite.dev/guide/env-and-mode) through `import.meta.env`. `import.meta.env.SSR` is true during build warmup and false in the browser.
- Keep helpers in the public directory too; a helper import that leaves it fails the dev server's check and the build, since the app does not serve it as source.
- The plugin compiles every `.ts` file in the public directory as a helper, serving and building it in that form instead of its source; keep other TypeScript out of the public directory.
- Editing or creating a public script or helper hot reloads the nodes loaded from it; changing which packages scripts import reloads the page.

Builds execute every public script headlessly in Node.js to warm the caches owned by its assets, then dispose the scenes. Execution and cleanup failures fail the build. Generated scenes are not saved, and scripts still execute normally when the app loads them.

Type checking: the plugin type checks the public `.glts` files and their helpers strictly, independently of the app's `tsconfig.json`, using the app's `typescript` 5 or 6; install it as a dev dependency, or `vite build` fails.

- Type errors fail `vite build`. During development they print in the terminal and hot reload continues.
- Only installed packages are typed: CDN packages and `https://` imports are untyped and cannot be used as types. Imports used only as types are never fetched, so they need the package installed.

## CLI inspection and export

Use the `drawcall glts` command for headless image checks and GLB export, without creating a viewer app. The CLI uses `@drawcall/webgpu`; for supported headless asset-loading patterns, see its [WebGPU skill](https://github.com/drawcall-ai/webgpu/blob/main/skills/webgpu/SKILL.md).

```sh
npx drawcall glts render dragon.glts -o dragon.png
npx drawcall glts render dragon.glts -o inspection.png --size 512 --time 0.5 \
  --views '[[{"camera":"+x"},{"camera":"persp"}],[{"camera":"+y","focus":{"center":[0,1,0],"radius":0.3},"title":"Detail"}]]'
npx drawcall glts export dragon.glts -o dragon.glb
```

Views are inline JSON rows. Axis cameras are orthographic and look from the named side toward the subject; `persp` fits a three-quarter perspective view. Omit views to use `scene.defaultCamera`, or a fitted perspective view when none is authored. Use `focus: "part-name"` to frame a uniquely named object's subtree while keeping surroundings; use `isolate: "part-name"` to show only that subtree. Bone joints have no mesh bounds, so inspect them with a world-space sphere focus.

Rendering loads with `isPreview: true` and advances frame callbacks in fixed steps to the requested time, then holds that state for every view. Lights, backgrounds, and effects belong in the asset's existing preview staging.

Export loads with `isPreview: false` and does not call frame callbacks. Assign explicit `THREE.AnimationClip`s to `scene.animations` to include animation. Use standard/physical or basic materials for GLB output; unsupported content fails instead of being silently discarded. Rendering profiles, environments, fog, and procedural behavior do not become GLB features. Export creates a new self-contained GLB from the constructed scene; it does not preserve an imported file byte for byte.

Bare packages resolve from the asset's project, and Three.js is shared with the host. Install additional packages in that project. Helpers and adjacent resource URLs work from disk; keep using `new URL("./resource", import.meta.url)`.

## Verify

When the project has a harness, load the asset with `new GLTSLoader(manager, { isPreview: true })`, call `update()` once and render with `GLTSRenderer`; if it sets `defaultCamera`, check both it and an explicit host camera. A successful load is not visual validation.
