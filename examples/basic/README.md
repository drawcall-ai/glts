# Basic example

This vanilla Vite/Three.js app exercises the V1 proof path:

- a root TypeScript `.glts` class;
- nested `branch.glts` wrapper components;
- `simplex-noise` through ESM.sh;
- `three-mesh-bvh`, whose `three` imports are redirected to the host module;
- a relative SVG resource resolved through rewritten `import.meta.url`;
- constructor-started texture tracking through `@drawcall/glts/asset`;
- explicit root and child reload buttons.

Run it from the workspace root with `pnpm dev`.
