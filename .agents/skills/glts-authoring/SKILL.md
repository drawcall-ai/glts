---
name: glts-authoring
description: Author and revise trusted procedural Three.js `.glts` asset modules, including nested assets, constructor-started resources, reload, and disposal. Use when creating or editing `.glts` files or reviewing GLTS asset code.
---

# GLTS authoring

Write each `.glts` file as a TypeScript ESM module with a no-argument default
export that constructs a `THREE.Object3D`. Keep top-level evaluation free of
side effects because reload evaluates new module revisions.

## Constructor resources

Pass the runtime manager to every Three.js loader that starts work during
construction. This is what makes a root `GLTSLoader.loadAsync()` or `load()`
completion include those requests.

```ts
import * as THREE from "three"
import { loadingManager } from "@drawcall/glts/asset"

export default class Branch extends THREE.Group {
  readonly leafTexture: THREE.Texture

  constructor() {
    super()
    this.leafTexture = new THREE.TextureLoader(loadingManager).load(
      new URL("./leaf.svg", import.meta.url).href,
    )
  }

  dispose() {
    this.leafTexture.dispose()
  }
}
```

Use the same pattern with `GLTFLoader`, `FileLoader`, and comparable Three.js
loaders. A resource failure rejects the root promise and reaches `load()`'s
error callback after the runtime manager becomes idle.

Nested `.glts` constructors automatically receive the enclosing runtime's
manager; do not pass a manager through constructors. Nested construction and
reload replacement stay synchronous. Arbitrary promises, timers, workers, and
other asynchronous work outside a Three.js loader using `loadingManager` are
not tracked.

Use one `GLTSLoader` for concurrent roots that request the same resolved
resource URL. Three.js may globally coalesce identical URLs without notifying
every manager, so that pattern is unsupported across loader instances.

## Composition and ownership

Import a nested asset with a relative `.glts` specifier and instantiate its
default wrapper synchronously. Do not depend on custom methods across that
wrapper boundary.

Resolve relative resources with `new URL(path, import.meta.url).href`. Release
only resources the asset owns in an optional `dispose()` method; the runtime
recursively disposes nested GLTS wrappers but does not infer geometry,
material, or texture ownership.

Keep imports within the supported contract: `three`, Three.js addons, nested
`.glts` modules, bare npm packages, and `@drawcall/glts/asset`. Do not introduce
dynamic imports, import attributes, local helper modules, cyclic GLTS imports,
or constructor arguments.
