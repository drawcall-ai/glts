# Architecture

GLTS has three cooperating layers.

## Module graph

`ModuleGraph` owns canonical asset URLs and evaluated source revisions. For a
root load it:

1. fetches the `.glts` source;
2. strips TypeScript with Sucrase;
3. discovers static imports with `es-module-lexer`;
4. resolves independent imports concurrently;
5. rewrites specifiers and `import.meta.url` with `magic-string`;
6. evaluates the resulting Blob URL as browser ESM.

Nested GLTS imports are prepared before their parent evaluates. Bare packages
and Three.js addons are requested from ESM.sh as bundles with `three` external.
Their remaining static module edges are recursively fetched and rewritten.

Fetched source and evaluated GLTS revisions are cached by canonical URL and
source content. Concurrent requests for the same module are deduplicated. A
forced reload still fetches with `no-cache`, but can reuse an already evaluated
identical revision.

## Host-module bridge

Blob modules cannot assume that a bundler will resolve a new bare `three`
specifier at runtime. `WrapperRuntime` therefore publishes the host Three.js
namespace through a loader-specific global key and generates a tiny Blob ESM
bridge containing its named exports.

All authored, addon, and npm imports of `three` point to that bridge. Runtime
validation uses the same host `THREE.Object3D`, preventing duplicate Three.js
identity problems.

The global bridge is an implementation mechanism, not a security boundary.
Trusted GLTS code already has access to `globalThis`.

## Wrapper runtime

Each canonical GLTS URL has one generated wrapper class derived from
`THREE.Group`. Constructing that class synchronously mounts the current raw
asset class. The runtime tracks live wrappers per URL with records held in a
`WeakMap`.

A reload evaluates the candidate class without activating it, then stages one
raw instance per live wrapper inside a construction transaction. If staging
fails, newly created nested wrappers and completed candidate instances are
disposed. If it succeeds, every wrapper is switched before old instances are
disposed.

Disposal traverses raw instances for nested runtime-owned wrappers and disposes
those recursively. It calls only the raw object's explicit `dispose()` method;
it does not infer ownership of general Three.js resources.

## Error boundary

`GLTSError` identifies the phase, canonical URL, import chain, and underlying
cause. Sucrase syntax diagnostics retain their source line and column, and
evaluated Blob modules receive an original-URL `sourceURL` marker.

Cleanup failures are never swallowed. A disposal error after a successful swap
is reported as a committed replacement with failed cleanup, which is distinct
from pre-commit failures where the mounted scene remains unchanged.
