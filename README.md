# GLTS

**Like glTF, but for procedural Three.js assets.**

A `.glts` file is a small TypeScript script that builds a scene with ordinary
Three.js code. `GLTSLoader` fetches and runs it and gives you a native
`THREE.Scene` that you can add anywhere, update every frame, hot reload, and
dispose.

Use GLTS when an asset is easier to write as code than to model: procedural
geometry, parametric or animated props, or assets written by AI coding agents.
Assets can load other assets, share code through helper modules, be
instanced, import npm packages, and bring their own preview staging and render
settings.

GLTS runs scripts as code, not in a sandbox. Only load scripts you trust.

```sh
pnpm add @drawcall/glts three
```

## Usage

A script builds its asset in the `scene` it imports:

```ts
// public/crystal.glts
import * as THREE from "three"
import { onDispose, onFrame, scene } from "@drawcall/glts"

const geometry = new THREE.IcosahedronGeometry()
const material = new THREE.MeshNormalMaterial()
const crystal = new THREE.Mesh(geometry, material)
scene.add(crystal)

onFrame((delta) => {
  crystal.rotation.y += delta
})

onDispose(() => {
  geometry.dispose()
  material.dispose()
})
```

The app loads it like any other Three.js asset:

```ts
import { GLTSLoader } from "@drawcall/glts"
import * as THREE from "three"

const loader = new GLTSLoader(new THREE.LoadingManager())
const crystal = await loader.loadAsync("/crystal.glts")
scene.add(crystal)

const timer = new THREE.Timer()
renderer.setAnimationLoop((time) => {
  timer.update(time)
  crystal.update(timer.getDelta())
  renderer.render(scene, camera)
})
```

## Agent skill

Everything else (helpers, composition, instancing, rendering, reload, packages,
and the Vite plugin) is documented in the
[GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md).
Install it for your coding agent:

```sh
npx skills add drawcall-ai/glts --skill glts
```

The skill also ships inside the `@drawcall/glts` npm package at
`skills/glts/SKILL.md`, so [skills-npm](https://github.com/antfu/skills-npm)
links it automatically from `node_modules`, at the version you have installed.
