---
name: drawcall-design
description: Create, modify, inspect, compose, and reuse GLTS scenes, Markdown documents, and image or Market references in Drawcall Design. Use whenever the user names Drawcall Design or one of its projects, canvases, frames, filesystems, GLTS assets, or Markdown frames. Do not use for full games, applications, or unrelated image generation.
---

# Drawcall Design

## MCP transport

MCP tools are the Drawcall transport in this environment. For Design operations, use only the tools documented here. A failed tool call does not make the transport unavailable.

Image frame creation uses a public HTTP(S) image URL.

Use `generate_design_image` only when the user asks for a 2D image or reference. Its references must be public HTTP(S) URLs. A 3D object, scene, or reusable asset is GLTS work, even when the user calls its canvas container a frame.

Tool arguments are JSON objects. File tools identify their target with `project` and a project-absolute `path`; they do not accept a separate `frame` argument. Call `list_design_files` and pass one of its returned paths unchanged.

For comments, call `list_design_comments` and, when needed, `get_design_comment` before changing a thread. Use `create_design_comment`, `reply_to_design_comment`, `resolve_design_comment`, `reopen_design_comment`, and `delete_design_comment` for their named operations. Structured tool calls use `body` for comment text. A positioned create requires the target frame's current `contentRevision` as `expectedContentRevision`; list frames again and re-inspect the position after a conflict.

```json
[
  {
    "tool": "list_design_projects",
    "arguments": {}
  },
  {
    "tool": "list_design_frames",
    "arguments": {
      "project": "r6z2n9k4x8m1qc"
    }
  },
  {
    "tool": "list_design_files",
    "arguments": {
      "project": "r6z2n9k4x8m1qc"
    }
  },
  {
    "tool": "read_design_file",
    "arguments": {
      "project": "r6z2n9k4x8m1qc",
      "path": "/a4z8m2q7v9kcde/index.glts"
    }
  },
  {
    "tool": "edit_design_file",
    "arguments": {
      "project": "r6z2n9k4x8m1qc",
      "path": "/a4z8m2q7v9kcde/index.glts",
      "oldText": "color: 0xffffff",
      "newText": "color: 0x000000"
    }
  },
  {
    "tool": "create_design_comment",
    "arguments": {
      "project": "r6z2n9k4x8m1qc",
      "frame": "a4z8m2q7v9kcde",
      "body": "The bevel catches the key light here.",
      "position": {
        "kind": "3d",
        "x": 0.2,
        "y": 1.1,
        "z": -0.4
      },
      "expectedContentRevision": 7
    }
  },
  {
    "tool": "reply_to_design_comment",
    "arguments": {
      "project": "r6z2n9k4x8m1qc",
      "comment": "c4z8m2q7v9kcdf",
      "body": "Adjusted the material roughness."
    }
  },
  {
    "tool": "resolve_design_comment",
    "arguments": {
      "project": "r6z2n9k4x8m1qc",
      "comment": "c4z8m2q7v9kcdf"
    }
  },
  {
    "tool": "generate_design_image",
    "arguments": {
      "project": "r6z2n9k4x8m1qc",
      "operation": "generate",
      "prompt": "A product photograph of this object",
      "references": [
        "https://r6z2n9k4x8m1qc.design.drawcallcontent.com/a4z8m2q7v9kcde.webp"
      ],
      "result": "new",
      "name": "Product photograph"
    }
  }
]
```

Design is a remote, current-state canvas. Inspect the project and its frames before changing them. Use immutable IDs for every project and frame target; names are mutable labels. In user-facing replies, refer to projects, frames, and other named resources by their current names. Do not expose their IDs unless the user explicitly asks for them; IDs may remain embedded in URLs that link to those resources.

We recommend using Drawcall Market when a design needs 3D assets such as models, textures, or environments.

## Project filesystem

A project is a hosted filesystem at `https://<project-id>.design.drawcallcontent.com/`. Each frame owns one top-level directory, `/<frame-id>`. Files use project-absolute paths that include that directory, for example `/a4z8m2q7v9kcde/index.glts`.

Create frames with an explicit type. Choose the type from the requested artifact, not from the word "frame": use GLTS for a 3D object or scene, Markdown for a formatted text document, image for an existing 2D image, and Market only for an exact public asset reference, `name@version`. GLTS and Markdown frames require a viewport size; image and Market frames derive their canvas size.

Read a file before editing it. Use a narrow edit for one known change and write a complete file when replacing it. GLTS and Markdown frame files may be created or deleted. Image and Market frame files are read-only.

## Frame images

Every frame has a public image at `https://<project-id>.design.drawcallcontent.com/<frame-id>.webp`. This URL represents the current rendered frame whether its type is GLTS, Markdown, image, or Market. Pass it as a reference URL to `generate_design_image` when one frame's appearance should inform another image.

## Markdown documents

A Markdown frame contains one optional source file at `/<frame-id>/index.md`; without it the frame renders as an empty document. Raw HTML is not rendered. Use ordinary Markdown image syntax with a frame's canonical WebP path to embed its current rendering:

```md
![Descriptive alternative text](/other-frame-id.webp)
```

An absolute canonical WebP URL from the same project is equivalent. A Markdown document may embed up to 32 existing GLTS, image, or Market frames. It may not embed itself or another Markdown frame. Use the canonical syntax instead of copying a screenshot URL or source asset so the document follows later frame changes.

Prefer focused Markdown frames. A document that covers separable topics is usually clearer as multiple frames connected with canonical links, `[Related details](/<frame-id>/)`, because readers can navigate directly to the part they need. An embedded frame is useful when its current rendering adds visual context; a link is better when the reader only needs to navigate.

## Comments and annotations

Use comments for review conversations and persistent annotations, including explanations of objects or regions inside 2D and 3D frames. Inspect the current comments before replying, resolving, reopening, or deleting so the action targets the current thread.

A comment without a position applies to its frame. A 2D position is normalized image space and applies only to an image frame. A 3D position is GLTS world space and applies only to a GLTS frame. Add a position only when its coordinates are authoritative; never infer 3D depth from a screenshot. Prefer a frame-level comment when the precise position is unknown.

Positioned comments retain the frame version on which they were placed. If the frame later changes, treat the position as potentially stale and re-inspect the frame before relying on it. Replies belong to the root comment's thread. Resolved threads do not accept replies, so reopen one before continuing it. Resolve a thread when its concern has been addressed. Delete a comment or reply only when explicitly requested because deletion is permanent; deleting a root also deletes its replies. Comment authors come from the authenticated Drawcall account—never invent an author identity.

## Failures

An error means the requested operation did not happen. Follow its next action without switching transport. Correct invalid arguments from the documented shape. Refresh projects, frames, or files after a not-found or conflict error, then reuse the exact returned IDs and paths. Retry an upstream or internal failure once; if it repeats, report the failed operation and error. Never repeat an unchanged failed operation.

## GLTS assets

A GLTS frame contains only `.glts` files. `index.glts` is its optional root asset; without it the frame renders empty. Every `.glts` file is a trusted TypeScript ESM module that default-exports a no-argument class derived from `THREE.Object3D`. Avoid top-level side effects because reload evaluates the module again. Implement `dispose()` when the asset exclusively owns disposable resources.

Author GLTS scenes top-down: create the root entry scene first, reference the child `.glts` assets it will compose, then implement those children progressively. A missing `.glts` import renders as a glowing marker labeled with its filename until the real file is written, so the completed parts of the scene remain visible. Treat the marker and its console warning as a temporary missing-dependency diagnostic, not as authored content.

```ts
import * as THREE from "three";
import Wheel from "./parts/wheel.glts";

export default class Racecar extends THREE.Group {
  constructor() {
    super();
    this.add(new Wheel());
  }
}
```

Use relative `.glts` imports within a frame. When a reusable 3D asset belongs in another frame, keep it in its own GLTS frame and import its root by project-absolute path from the consuming frame. Instantiate that import as often as needed instead of copying its source:

```ts
import Chassis from "/other-frame-id/index.glts";
```

For a non-GLTS file from an image or Market frame, preserve the project filesystem URL through `import.meta.url`:

```ts
const modelUrl = new URL("/market-frame-id/models/car.glb", import.meta.url);
```

When a `.glts` constructor starts resource loading through a Three.js loader, import the current runtime's manager and pass it to that loader. This makes the initial root `loadAsync()` promise or `load()` callback wait for the resource and surface its failure. Use it with `TextureLoader`, `GLTFLoader`, `FileLoader`, and comparable loaders. Reload construction remains synchronous, and arbitrary asynchronous work is not tracked.

```ts
import * as THREE from "three";
import { loadingManager } from "@drawcall/glts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export default class Car extends THREE.Group {
  constructor() {
    super();
    new GLTFLoader(loadingManager).load(
      new URL("./car.glb", import.meta.url).href,
      ({ scene }) => this.add(scene),
    );
  }
}
```

GLTS supports static `.glts`, `three`, Three addons, and bare npm imports. It does not support helper `.ts` modules, dynamic imports, cyclic GLTS graphs, or cross-asset inheritance. Keep the asset self-contained and compose with nested GLTS assets.

Keep preview-only camera and lighting out of the default scene so importing the GLTS composes only reusable content. A root `index.glts` may export `previewCamera` and `previewLighting`; these named exports affect its direct preview and are ignored when another GLTS imports it. `previewLighting` must be a `THREE.Object3D` containing at least one light.

```ts
import * as THREE from "three";

export const previewCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
previewCamera.position.set(4, 3, 6);
previewCamera.lookAt(0, 0, 0);

export const previewLighting = new THREE.Group();
previewLighting.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2));

export default class Product extends THREE.Group {
  // Reusable scene content only.
}
```

When `previewCamera` is absent, the viewer uses the first camera found by depth-first traversal, then autofits if the scene has none. A saved frame camera remains the user override. Double-clicking a frame enters orbit from the resolved view; deselecting restores it.

Treat authoritative source or structured state as sufficient when it directly and completely determines the requested property. Do not take a screenshot merely to reconfirm that evidence. Take one only when the result depends on rendering or visual relationships the source cannot establish, such as layout, overlap, clipping, camera framing, lighting, or runtime-generated appearance, or when the user explicitly asks. Then inspect it against the request and iterate until the evidence supports completion.
