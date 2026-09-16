---
name: glts
description: Author or review procedural Three.js `.glts` asset scripts, including presentation, resources, composition, instancing, animation, reload, and disposal. Use when creating, editing, or reviewing a `.glts` file; not for host-only Three.js application code.
---

# GLTS authoring

Build the asset in the imported `scene`, a native `THREE.Scene`. A `.glts` file is an exportless TypeScript ESM script, not a class or factory:

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

The contextual runtime imports are `gltsLoader`, `instanceCount`, `isPreview`, `loadingManager`, `onDispose`, `onFrame`, `onMatrixUpdateAt`, and `scene`. Use named imports. Do not import `GLTSLoader`, `GLTSRenderer`, or other runtime values from `@drawcall/glts`; type-only imports are allowed. Do not export anything, including types or interfaces.

## What a script may import

Scripts may import `three`, `three/addons/*`, and browser-compatible npm packages. Static `.glts` imports, dynamic `import()`, import attributes, and local modules such as `./shared.ts` are rejected. Keep the file self-contained.

`import.meta.url` is rewritten to the script's own source URL, so `new URL("./thing.png", import.meta.url)` resolves against the `.glts` file and not against the runtime's generated module.

## Scene and presentation

Use native scene properties directly: `scene.background`, `scene.environment`, `scene.fog`, `scene.overrideMaterial`, and the normal `Object3D` API. Assign a `THREE.Camera` to `scene.defaultCamera` when the asset has a useful authored view. It is a recommendation: the host may ignore it or pass another camera to the renderer, and remains responsible for adapting its projection to the viewport. The camera need not be in the scene graph unless it depends on an authored parent; a camera in the hierarchy makes automatic instancing ineligible. GLTS does not search the hierarchy for cameras. The same loaded scene can be added beneath another Three.js scene or rendered as the root.

The host owns the root `scene` transform. Put authored placement under a child group; do not set `scene.position`, rotation, quaternion, scale, or matrix.

Gate only staging added solely for standalone inspection with `isPreview`, such as a neutral floor, light rig, or preview background. Keep intrinsic content, including each mesh's shadow participation, unconditional. Do not create a renderer, display canvas, resize handler, animation loop, or controls. The application owns those and may select another camera on every render.

```ts
import { isPreview, scene } from "@drawcall/glts"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { Vector2 } from "three"

if (isPreview) {
  scene.rendering.effects.push(({ height, width }) =>
    new UnrealBloomPass(new Vector2(width, height), 0.3, 0.4, 0.85),
  )
}
```

Visible shadows require all three: `scene.rendering.shadows = true`, `castShadow = true` on a shadow-capable light and intended meshes, and `receiveShadow = true` on receivers. Dispose shadow-casting lights. For PBR image-based lighting, assign a correctly mapped `Texture` or `CubeTexture` to `scene.environment` and dispose it with the other owned resources; do not create a renderer or `PMREMGenerator` in the asset.

`scene.rendering` supports `shadows`, `localClippingEnabled`, `toneMapping`, `toneMappingExposure`, and `effects`. An effect factory receives the host's selected `camera`, the loaded `scene`, and the initial drawing-buffer `width` and `height`, and returns a Three.js `Pass` compatible with `WebGLRenderer.setEffects()`. The selected camera is the explicit host camera, or `scene.defaultCamera` when the host omits one. Use that camera and scene when an effect needs them. Rendering without either camera fails. Never add `RenderPass` or `OutputPass`; the GLTS renderer performs both stages. It owns and disposes factory-created passes, so do not register them with `onDispose`. A custom pass must release its own GPU resources in `dispose()`.

Configure `scene.rendering` during script evaluation, not from frame, matrix, timer, or event callbacks.

Create a fresh pass on every factory invocation. Factories are synchronous and may run again when the selected camera or factory list changes. Put any factory-owned GPU resources and listeners inside the pass, release them in its `dispose()`, and restore transient renderer or scene state in `finally`, including when `render()` throws. Never load resources from an effect factory.

Only the root given to the host's `GLTSRenderer.render()` controls presentation. When this asset is nested, its `background`, `environment`, `fog`, `overrideMaterial`, `defaultCamera`, and `rendering` profile are naturally ignored and the outer scene wins. Nested scripts receive `isPreview === false`.

## Resources and cleanup

Pass the contextual `loadingManager` to Three.js loaders during script evaluation. GLTS waits for every request reported through it, including loads whose promise was not awaited. Top-level `await` is supported. The loading scope then closes: never start loads from `onFrame`, `onMatrixUpdateAt`, effect factories, timers, or event callbacks.

Construct any LoadingManager extension handler with the contextual manager and register it there. Host-bound handler instances are not inherited.

Three.js loaders take strings, so pass `new URL("./bark.png", import.meta.url).href`. GLTS loader methods accept the `URL` itself.

Release only resources created by the script. GLTS disposes nested managed nodes recursively but does not infer geometry, material, or texture ownership. Disposal callbacks run in reverse registration order.

Close disposal callbacks over the owned resources themselves. Do not discover them by traversing `scene`: reload detaches the outgoing children before it runs their disposal callbacks.

## Composition

Use the contextual `gltsLoader` and resolve relative paths explicitly:

```ts
import { gltsLoader, scene } from "@drawcall/glts"

const wheel = await gltsLoader.loadAsync(
  new URL("./wheel.glts", import.meta.url),
)
scene.add(wheel)
```

Add every loaded result beneath `scene` before the script finishes. Leaving one unattached is an error. The contextual loader supports `loadAsync()` and `loadInstancesAsync()`, not `reload()`. Do not create cyclic loads. Once attached, a nested result is disposed recursively. Do not register `child.dispose()` with `onDispose`.

## Instancing

For an ordinary mesh hierarchy, the caller's `loadInstancesAsync(url, count)` automatically converts each mesh to a `THREE.InstancedMesh`. Automatic instancing is strict:

- any `Camera`, `Light`, `Line`, `Points`, `Sprite`, `LOD`, `SkinnedMesh`, `InstancedMesh`, or `BatchedMesh` in the hierarchy fails the load;
- morph targets fail the load, and at least one mesh is required;
- `onFrame` fails the load;
- any nested GLTS scene fails the load because child reloads could otherwise invalidate the generated batch.

Preview-only lights also make automatic instancing ineligible. A host loading instances should not enable preview mode for that load.

Keep animation out of an instanceable asset and let the parent write poses with `setMatrixAt()`. When the asset genuinely needs its own per-instance behavior, opt into native instancing instead:

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

Registering `onMatrixUpdateAt` selects native instancing, replays the current matrices immediately, and receives every later outer `setMatrixAt()`. The script still executes exactly once. `instanceCount` is `1` for a plain `loadAsync()`, so a native-instancing script stays valid when loaded as a single scene.

## Physics

The host owns physics setup, stepping, and disposal; scripts inherit its world through nested loads and reloads.

Import from `@drawcall/physics`. Put meshes and colliders beneath `RigidBody` groups, and bodies and joints beneath `scene`. Bodies cannot nest. Units are meters, kilograms, seconds, and radians.

| Object | Constructor | Setters |
| --- | --- | --- |
| `RigidBody` | `type` (`"dynamic"` by default, `"static"`, or `"kinematic"`), `mass`, `colliders` (`"auto"`, `"box"`, `"convexHull"`, `"trimesh"`, or `false`) | `setVelocity({ linear, angular })`, `setLinearDamping(value)`, `setAngularDamping(value)`, `setGravityScale(value)`, `setMaterial(material)` |
| Colliders | `BoxCollider({ size: [x, y, z] })`, `SphereCollider({ radius })`, `CapsuleCollider({ radius, length })`, `CylinderCollider({ radius, height })`, `MeshCollider({ approximation })` (`"convexHull"` or `"trimesh"`) | `setMaterial(material)`, `setSensor(boolean)`; mesh: `setGeometry(bufferGeometry)` |
| Joints | `FixedJoint`, `SphericalJoint`, `RevoluteJoint`, `PrismaticJoint`, or `DistanceJoint`: `{ body0, body1 }`; revolute/prismatic: `axis` (X/Y/Z, default Y), `limits: [min, max]`; distance: `limits` (default `[0, 0]`) | `setEnabled(boolean)`, `setCollideConnected(boolean)` |
| `JointMotor` | `{ joint, stiffness?, damping?, maxForce? }` for a revolute/prismatic joint | `setTarget({ position, velocity })`, `setEnabled(boolean)` |

Automatic colliders follow each mesh: unchanged primitives retain their shape; other dynamic/kinematic geometry uses convex hulls, static geometry uses triangle meshes. Explicit colliders replace automatic ones. Triangle meshes require static bodies; instanced, skinned, or morph-deformed meshes need explicit colliders. Capsules/cylinders extend along Y; capsule `length` excludes hemispheres.

Materials accept `staticFriction`, `dynamicFriction`, `restitution`, and `density`; collider values override body values. Mass comes from collider density unless `mass` supplies a total.

Joint placement defines initial anchors. Alternatively, supply both `frame0` and `frame1` as body-local `Matrix4`s. `body0: null` anchors to the world, with world-space `frame0`.

One motor per axis joint; it starts untargeted. `setTarget` accepts either coordinate or both, replacing omissions with zero. With zero stiffness, targets control velocity; a zero velocity target with damping brakes motion. Position/velocity use radians and rad/s for hinges, meters and m/s for sliders. `maxForce` caps force in N or torque in N·m; omission leaves it unbounded. `joint.getState()` returns `{ position, velocity }` for these joints.

Set initial transforms during construction. For later motion, use `teleport(pose)` or, for kinematic bodies, `setKinematicTarget(pose)`. Both take rigid world-space `Matrix4`s; `splitTransform(body.matrixWorld).pose` removes scale. `getVelocity()` returns world-space `Vector3` values `{ linear, angular }`; partial `setVelocity` preserves the other component. Animate targets through GLTS `onFrame`.

Author scale before simulation; later changes require recreating affected bodies and joints. Positive uniform scale works for all shapes. Boxes/meshes allow nonuniform scale; cylinders need equal X/Z scale; spheres/capsules need uniform scale (use a convex hull to stretch them). Dynamic/kinematic bodies need uniformly scaled ancestors. Zero/negative scale and shear are rejected. Scale changes shapes and anchors, not explicit mass, velocity, or joint limits.

GLTS disposes execution-owned bodies and joints, including clones and unattached objects. Use `clone(root)` to copy a mechanism and reconnect its internal joints and motors. Physics assets need separate scene loads; `loadInstancesAsync()` is unsupported.

For custom controllers, forces/effort, simulation-step callbacks, raycasts, collision filtering, explicit mass properties, or inspection, consult the [physics API](https://github.com/drawcall-ai/physics#readme).

Physics writeback and teleportation refresh `body.matrixWorld`. After authoring or hierarchy edits, refresh it with `body.updateWorldMatrix(true, false)` before reading. GLTS does not refresh matrices before `onFrame`; follow the host contract.

Static previews use `AuthoringWorld`: authored poses remain visible and simulation commands are inert. Body velocity reads/writes and teleportation work without simulation.

## Frame updates

`onFrame((delta) => ...)` runs when the host calls `update(delta)` on the loaded root; updating a root also updates its managed descendants.

## Reload-safe code

Reload keeps the managed node's identity, host-owned transform, and outer instance matrices. It replaces children and refreshes authored scene, `defaultCamera`, and rendering state.

The imported `scene` is a live binding that follows the stable node after reload. Frame callbacks may reference it directly. Do not alias it; the alias would retain the temporary revision scene.

A failed reload leaves current content mounted.

When a project harness exists, verify the asset by loading it with `GLTSLoader` and rendering it through the preview path. When it defines `defaultCamera`, verify both the fallback and an explicit host override. Successful transformation alone is not type or visual validation.
