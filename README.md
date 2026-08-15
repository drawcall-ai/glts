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

const tree = await new GLTSLoader().loadAsync("/assets/tree.glts")

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

Supported static imports:

| Import | Resolution |
| --- | --- |
| `three` | The host application's exact Three.js namespace |
| `three/addons/...` or `three/examples/...` | Matching Three.js revision through ESM.sh |
| `./child.glts` | A stable loader-managed wrapper constructor |
| Bare npm package | An ESM.sh bundle with `three` redirected to the host |

`import.meta.url` is rewritten to the original `.glts` URL, so relative
textures and other browser-loaded resources continue to work.

Dynamic imports, import attributes, local helper `.ts` modules, cyclic module
graphs, cross-asset inheritance, and custom-method contracts across a `.glts`
boundary are intentionally outside V1.

## Reload behavior

Every root and imported asset has a stable wrapper:

```text
Tree wrapper
  └── current Tree instance
        └── Branch wrapper
              └── current Branch instance
```

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
