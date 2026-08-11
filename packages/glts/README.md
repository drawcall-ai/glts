# @drawcall/glts

**Like glTF, but for procedural Three.js assets.**

`@drawcall/glts` loads trusted TypeScript modules as composable Three.js assets.
It compiles them in the browser, resolves nested `.glts` and npm imports, and
keeps a stable `THREE.Group` wrapper around every asset for atomic reloads.

## Install

```sh
pnpm add @drawcall/glts three
```

## Load an asset

```ts
import { GLTSLoader } from "@drawcall/glts"

const loader = new GLTSLoader()
const tree = await loader.loadAsync("/assets/tree.glts")

scene.add(tree.scene)

await tree.reload()
await loader.reload("/assets/branch.glts")

tree.dispose()
loader.dispose()
```

`load()` is also available with the familiar Three.js callback API.

GLTS initializes its browser compiler automatically. It requires no bundler
plugin or WASM configuration.

## Write an asset

Each `.glts` file default-exports a no-argument class derived from
`THREE.Object3D`:

```ts
import * as THREE from "three"
import Branch from "./branch.glts"

export default class Tree extends THREE.Group {
  constructor() {
    super()
    this.add(new Branch())
  }

  dispose() {
    // Release resources owned by this asset.
  }
}
```

Asset modules can import `three`, Three.js addons, nested `.glts` assets, and
bare npm packages. `import.meta.url` resolves to the original asset URL so
relative textures and other resources continue to work.

## V1 constraints

Dynamic imports, import attributes, local helper `.ts` modules, cyclic module
graphs, cross-asset inheritance, and custom-method contracts across a `.glts`
boundary are intentionally outside V1.

## Security

GLTS is executable code, not a sandbox or serialization format. Only load
assets you trust; they run with the page's full JavaScript authority.

Three.js `0.160.0` or newer is required as a peer dependency. Licensed under
MIT.
