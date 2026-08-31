# GLTS

**Like glTF, but for procedural Three.js assets.**

GLTS loads trusted TypeScript modules as composable Three.js assets. It compiles
them in the browser, resolves nested `.glts` and npm imports, and gives every
asset a stable `THREE.Group` wrapper so its implementation can be replaced
without disturbing its place in the scene.

```ts
import * as THREE from "three"
import Branch from "./branch.glts"

export default class Tree extends THREE.Group {
  constructor() {
    super()
    this.add(new Branch())
  }
}
```

GLTS is executable code, not a sandbox or a serialization format. Only load
assets you trust.

## Workspace

| Path | Purpose |
| --- | --- |
| `packages/glts` | Browser loader, compiler, module graph, wrappers, and reload runtime |
| `examples/basic` | Vanilla Three.js example covering nested assets, npm, resources, and reload |

The repository follows the same pnpm workspace structure as the neighboring
Drawcall Three.js projects.

## Run it

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:5173>. Edit
`examples/basic/public/assets/tree.glts` or `branch.glts`, then use the example's
reload buttons to replace that asset in place.

Useful workspace commands:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check
```

## Use the loader

Install the runtime next to the application's own Three.js dependency:

```sh
pnpm add @drawcall/glts three
```

```ts
import { GLTSLoader } from "@drawcall/glts"

const loader = new GLTSLoader()
const tree = await loader.loadAsync("/assets/tree.glts")

scene.add(tree.scene)

await tree.reload()
await loader.reload("/assets/branch.glts")

tree.dispose()
```

GLTS initializes its browser compiler automatically. It requires no bundler
plugin or WASM configuration.

`load()` is also available with the familiar Three.js callback shape:

```ts
loader.load(
  "/assets/tree.glts",
  (asset) => scene.add(asset.scene),
  undefined,
  (error) => console.error(error)
)
```

### Create several managed instances

Load the reusable managed constructor when one prepared asset needs several
instances:

```ts
const Tree = await loader.loadAsyncConstructor("/assets/tree.glts")

const first = new Tree()
const second = new Tree()
await Promise.all([first.ready, second.ready])

scene.add(first, second)
first.dispose()
```

`new Tree()` is synchronous and returns a stable `THREE.Group` wrapper. Its
`ready` promise settles when constructor-started Three.js resources have
finished. Each live instance participates in `reload()`, `has()`, and loader
ownership; `loader.dispose()` disposes any instances that remain. Repeated
constructor retrieval for the same URL returns the same constructor, while
each construction creates a distinct raw asset.

This constructor is GLTS's managed wrapper, not the class default-exported by
the asset. Authored methods and properties stay on the raw child and are not
part of the managed API. Use `loadAsync()` when one already-ready `GLTSAsset`
is more convenient.

## Asset contract

Each `.glts` file must:

- be a TypeScript ESM module;
- default-export a constructible class;
- accept no constructor arguments;
- construct a value derived from `THREE.Object3D`;
- avoid top-level side effects, because new revisions are evaluated again.

An optional `dispose()` method releases resources owned by the raw asset:

```ts
export default class Rock extends THREE.Mesh {
  constructor() {
    const geometry = new THREE.IcosahedronGeometry()
    const material = new THREE.MeshStandardMaterial()
    super(geometry, material)
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
```

A root module may also export preview-only camera and lighting metadata:

```ts
export const previewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)

export const previewLighting = new THREE.Group()
previewLighting.add(new THREE.AmbientLight(0xffffff, 0.5))

export default class Tree extends THREE.Group {
  // Reusable scene content only.
}
```

`previewCamera` must be a `THREE.Camera`. `previewLighting` must be a
`THREE.Object3D` containing at least one `THREE.Light`. The loader exposes them
as `asset.previewCamera` and `asset.previewLighting`; neither is added to
`asset.scene`. Both properties are `undefined` when omitted and update after a
successful reload. When a `.glts` module is imported by another asset, only its
default scene export is composed into the parent.

Supported static imports:

| Import | Resolution |
| --- | --- |
| `three` | The host application's exact Three.js namespace |
| `@drawcall/glts` | `loadingManager` for the current loader runtime |
| `three/addons/...` or `three/examples/...` | Matching Three.js revision through ESM.sh |
| `./child.glts` | A stable loader-managed wrapper constructor |
| Bare npm package | An ESM.sh bundle with `three` redirected to the host |

`import.meta.url` is rewritten to the original `.glts` URL, so relative
textures and other browser-loaded resources continue to work.

### Constructor-started resources

Pass the runtime's `loadingManager` to any Three.js loader that starts resource
work in a constructor:

```ts
import * as THREE from "three"
import { loadingManager } from "@drawcall/glts"

export default class Branch extends THREE.Group {
  readonly leafTexture: THREE.Texture

  constructor() {
    super()
    this.leafTexture = new THREE.TextureLoader(loadingManager).load(
      new URL("./leaf.svg", import.meta.url).href,
    )
  }
}
```

This applies to `TextureLoader`, `GLTFLoader`, `FileLoader`, and comparable
loaders. A root `loadAsync()` promise and `load()` callback complete only after
synchronous GLTS construction and the runtime manager becoming idle. Resource
failures reject the promise or reach the error callback at that boundary.

The package root remains safe to import in application code. Using its
`loadingManager` export outside a `.glts` module evaluated by `GLTSLoader`
throws, because no loader runtime exists there.

Nested `.glts` constructors need no special handling: they automatically use
the enclosing runtime. Each `GLTSLoader` owns one manager, shared by all of its
roots. Use one loader for concurrent roots that request the same resolved
resource URL; Three.js may globally coalesce that URL without notifying every
manager, so doing this across loaders is unsupported. Nested construction and
reload replacement stay synchronous and do not wait for resources they start.
Arbitrary asynchronous work outside a Three.js loader using `loadingManager`
is not tracked.

Dynamic imports, import attributes, local helper `.ts` modules, cyclic module
graphs, cross-asset inheritance, and custom-method contracts across a `.glts`
boundary are intentionally outside V1.

## Inline a source graph

`inline()` combines an in-memory GLTS graph into one TypeScript ESM string. It
does not transpile the TypeScript or convert the entry module to another module
format.

```ts
import { inline } from "@drawcall/glts"

const source = inline(treeSource, {
  "./branch.glts": branchSource,
  "./leaf.glts": leafSource,
})
```

The entry module's external imports, body, and exports stay in place. Local
`.glts` imports become `THREE.Group` wrapper constructors around isolated
dependency scopes, preserving the same nesting as loader-managed imports.
External imports used by those scopes are added to the entry module and
deduplicated by their local binding, so namespace and named imports can coexist:

```ts
import * as THREE from "three"
import { Group } from "three"
```

Paths in the source record are relative to the entry module unless they start
at `/` or are absolute URLs. Each dependency must default-export a class and
may only use default imports for other local `.glts` files. Dependency named
exports other than `previewCamera` and `previewLighting`, dynamic imports,
import attributes, local helper modules, conflicting external bindings, and
cycles fail with a `GLTSError`. Dependency
`import.meta.url` expressions still resolve to the original source path. Local
GLTS imports are constructor values rather than TypeScript type imports. The
two preview exports are permitted in inlined dependencies but remain local to
their source.

## Reload behavior

Every root and imported asset has a stable wrapper:

```text
Tree wrapper
  └── current Tree instance
        └── Branch wrapper
              └── current Branch instance
```

Each wrapper starts with its canonical source URL as its Three.js `name`,
including wrappers for imported and inlined `.glts` dependencies.

Reloading `branch.glts` constructs all replacement branches off-scene. Only
after every constructor succeeds does GLTS swap them into their existing
wrappers. A fetch, compile, resolution, evaluation, or construction failure
leaves the old instances mounted. Replacement intentionally resets raw asset
state.

`loader.has(url)` reports whether an asset is reachable from at least one
undisposed root. Reloading a root updates that reachability to its latest
successful set of imports.

GLTS calls `dispose()` on replaced raw instances. It does not automatically
dispose geometries, materials, or textures because those resources may be
shared. Nested GLTS wrappers are owned and disposed recursively by the runtime.

## Operational constraints

- The application must use one Three.js version.
- Source, CDN modules, and relative resources must be CORS-accessible.
- The page's CSP must allow `blob:` modules and configured CDN sources.
- ESM.sh package versions are intentionally live in V1; reproducible locking is
  future work.
- GLTS code runs with the page's full JavaScript authority.
