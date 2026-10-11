# Physics ragdoll example

Run `pnpm --filter @drawcall/glts-example-physics dev` from the GLTS repo.

The ragdoll falls onto a floor using automatic colliders, spherical joints, and
limited elbows and knees. Drag to orbit, Reset to restart, or Export USDZ to
save its pose with physics. The asset is
[public/ragdoll.glts](public/ragdoll.glts).

## How it fits together

GLTS knows nothing about physics. The app connects the two:

```ts
import { buildWorld } from "@drawcall/physics-rapier"

const asset = await new GLTSLoader(manager).loadAsync("/ragdoll.glts")
scene.add(asset)
const world = await buildWorld({ scene })
```

- The `glts()` Vite plugin gives scripts the app's own `@drawcall/physics`,
  because the app installs it, so the world simulates the bodies they create.
  Without a shared copy, scripts would get a separate one whose bodies the
  world ignores.
- The world simulates whatever is under its `scene`. A reload swaps the asset's
  children, so the old bodies leave and the new ones join at the next update.
- Scripts only author objects. They never build or step a world, and they set
  starting state through constructor options and transforms, such as
  `new RigidBody({ velocity: { linear: [x, y, z] } })`. Simulation commands like
  `applyImpulse` work once the asset is under the world's scene, for example in
  `onFrame`.
- Triangle meshes that a backend collides as convex parts need
  `await world.decompose(asset)` before the asset joins a running world.
- Export with `PhysicsUSDExporter` from `@drawcall/physics-usd`, passing
  `world.gravity`.

See the [physics README](https://github.com/drawcall-ai/physics#readme) for
the physics API.
