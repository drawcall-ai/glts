# Basic example

A single authored subject — one procedural tree at dusk — rendered from two
`.glts` scripts that the browser fetches, compiles, and executes at runtime.

Run it from the workspace root with `pnpm dev`.

## What the example proves

| Claim | Where |
| --- | --- |
| Scripts export nothing; they populate the imported `scene` | both `.glts` files |
| Nested assets load through the contextual `gltsLoader` | `tree.glts` loads `branch.glts` |
| `loadInstancesAsync()` + `setMatrixAt()` compose explicitly | `tree.glts` poses 15 branches |
| Ordinary mesh hierarchies are instanced automatically | `branch.glts` has no instancing code |
| `onFrame` / `onDispose` drive motion and cleanup | `tree.glts`, `branch.glts` |
| The contextual `loadingManager` gates the load on resources | `branch.glts` fetches `leaf.svg` |
| Root and nested source reload independently | the two buttons |
| The loaded root is an ordinary `THREE.Group` | `scene.add(tree)` in `main.ts` |

## Composition

`tree.glts` sweeps its trunk as a tapered tube and then loads `branch.glts`
twice from the same URL. Each successful child is attached immediately, so a
later failure remains inside the parent's rollback boundary:

```ts
const branchURL = new URL("./branch.glts", import.meta.url)
const bough = await gltsLoader.loadAsync(branchURL)
crown.add(bough)
const branches = await gltsLoader.loadInstancesAsync(branchURL, BRANCHES)
crown.add(branches)
```

The first result is a nested scene used for the low bough. The second is an
instanced node whose fifteen matrices `tree.glts` rewrites in `onFrame` so the
whole crown moves with one shared wind vector. Because both nodes came from the
same URL, **Reload branches** (`loader.reload("/assets/branch.glts")`) rebuilds
them together while **Reload tree** (`tree.reload()`) replaces the root's
contents in place — the group identity, its transform, and your camera survive.

`branch.glts` deliberately registers no `onFrame`. Automatic instancing rejects
animated hierarchies, so an asset intended to be instanced keeps its motion
outside and receives poses through `setMatrixAt()`. It builds all leaves into
one buffer, so the entire instanced canopy remains one foliage draw call plus
one twig draw call; the triangle and draw-call readout in the corner is live.

The leaf silhouette is an `alphaMap` fetched with the contextual
`loadingManager`, so the parent load only resolves once the texture has decoded,
and the shadow pass cuts the same silhouette — that is where the dapple on the
ground comes from.

## Local and procedural

Everything is generated in the browser from vanilla Three.js: the bark and
pollen textures, the dusk sky (one equirectangular canvas that serves as
background, image-based lighting, and the position of the key light), and the
ground. The only fetched resource is `leaf.svg`. No CDN modules, no addons
beyond `OrbitControls`.

Scripts cannot import local helper modules, so each `.glts` file is
self-contained by design.
