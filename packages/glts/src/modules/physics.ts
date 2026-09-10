import type * as Physics from "@drawcall/physics";
import type { ScriptContext } from "../scene/execution.js";

export function bindPhysics(
  physics: typeof Physics,
  context: ScriptContext,
  world: Physics.PhysicsWorld,
): typeof Physics {
  class RigidBody extends physics.RigidBody {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === RigidBody
        ? value instanceof physics.RigidBody
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Physics.RigidBodyOptions = {}) {
      context.assertActive();
      super(options, options.world ?? world);
      context.ownPhysics(this);
    }
  }
  class Joint<
    Options extends Physics.JointOptions = Physics.JointOptions,
  > extends physics.Joint<Options> {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === Joint
        ? value instanceof physics.Joint
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Options) {
      context.assertActive();
      super(options);
      context.ownPhysics(this);
    }
  }
  class AxisJoint extends physics.AxisJoint {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === AxisJoint
        ? value instanceof physics.AxisJoint
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Physics.AxisJointOptions) {
      context.assertActive();
      super(options);
      context.ownPhysics(this);
    }
  }
  class FixedJoint extends physics.FixedJoint {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === FixedJoint
        ? value instanceof physics.FixedJoint
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Physics.JointOptions) {
      context.assertActive();
      super(options);
      context.ownPhysics(this);
    }
  }
  class RevoluteJoint extends physics.RevoluteJoint {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === RevoluteJoint
        ? value instanceof physics.RevoluteJoint
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Physics.AxisJointOptions) {
      context.assertActive();
      super(options);
      context.ownPhysics(this);
    }
  }
  class PrismaticJoint extends physics.PrismaticJoint {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === PrismaticJoint
        ? value instanceof physics.PrismaticJoint
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Physics.AxisJointOptions) {
      context.assertActive();
      super(options);
      context.ownPhysics(this);
    }
  }
  class SphericalJoint extends physics.SphericalJoint {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === SphericalJoint
        ? value instanceof physics.SphericalJoint
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Physics.JointOptions) {
      context.assertActive();
      super(options);
      context.ownPhysics(this);
    }
  }
  class DistanceJoint extends physics.DistanceJoint {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return this === DistanceJoint
        ? value instanceof physics.DistanceJoint
        : super[Symbol.hasInstance](value);
    }
    constructor(options: Physics.DistanceJointOptions) {
      context.assertActive();
      super(options);
      context.ownPhysics(this);
    }
  }
  const clone: typeof physics.clone = (root) => {
    context.assertActive();
    return physics.clone(root);
  };
  return {
    ...physics,
    getDefaultWorld: () => world,
    RigidBody,
    Joint,
    AxisJoint,
    FixedJoint,
    RevoluteJoint,
    PrismaticJoint,
    SphericalJoint,
    DistanceJoint,
    clone,
  };
}
