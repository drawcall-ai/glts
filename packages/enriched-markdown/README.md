# @drawcall/glts-enriched-markdown

Draws [GLTS](https://github.com/drawcall-ai/glts) assets in [react-native-enriched-markdown](https://github.com/software-mansion/enriched-markdown). An image on its own line whose URL ends in `.glts` renders as its live Three.js scene:

```md
![A spinning crystal](https://example.com/crystal.glts)
```

```sh
pnpm add @drawcall/glts-enriched-markdown @drawcall/glts three
```

```tsx
import { renderGLTSImage } from "@drawcall/glts-enriched-markdown"
import { EnrichedMarkdownText } from "react-native-enriched-markdown"

<EnrichedMarkdownText markdown={markdown} renderers={{ image: renderGLTSImage }} />
```

`renderGLTSImage` returns `undefined` for every other image, so the default renderer keeps them. To combine it with your own image renderer, try it first: `image: (block) => renderGLTSImage(block) ?? myImage(block)`.

Each asset loads with `isPreview: true` into a 16:9 WebGPU canvas, through the asset's `defaultCamera` when it has one. A failed load or frame shows the error message in place of the canvas.

- Web only for now: GLTS does not yet run on React Native's Hermes engine.
- Inline images, and images in lists or tables, stay images, as `renderers` only replaces standalone blocks.
- GLTS runs scripts as code, not in a sandbox. Render only Markdown whose `.glts` links you trust.
