# Current-API racecar prompt

This is the original Drawcall Design prompt adapted to the current local GLTS
API and transport. The creative request is unchanged. Multiple `.glts` files
are explicitly allowed because the reference used six files. The exact
`skills/glts/SKILL.md` read by the run is preserved as
[`current-skill.md`](./current-skill.md).

```text
You are a coding agent working in the GLTS repository. Read
skills/glts/SKILL.md once first and follow it. Use the repository's normal file,
shell, and browser tools for the task.

User request:

"In the GLTS viewer, build a 3D vintage racecar."

Create the asset at
examples/viewer/public/assets/showcases/vintage-racecar/index.glts. Multiple
.glts files are fine: use the current contextual gltsLoader API to compose them.
Add the racecar to the viewer as a bundled showcase and adapt its tests.

Use the current GLTS API throughout: author into the contextual scene, compose
children with gltsLoader, assign the authored view to scene.defaultCamera, gate
standalone staging with isPreview, configure presentation through native scene
properties and scene.rendering, and clean up owned resources with onDispose.
Do not use legacy default-export classes, static .glts imports, previewCamera,
or previewLighting.

This is a quality comparison, not a brevity exercise. Do not impose a line or
file limit. Build and visually inspect your result in the actual viewer, then
iterate until it is a polished, immediately recognizable vintage racecar.

For a fair independent generation, do not inspect the old racecar project,
source, screenshots, transcripts, benchmark results, or
benchmarks/vintage-racecar/prompts/original.md. Do not inspect or copy the
source of the three existing showcase assets. You may inspect application and
test code needed to integrate and verify your new showcase.

When you are done, reply with: (1) one sentence on the result, (2) the exact
ordered list of files you created or changed with their final line counts, and
(3) the verification you ran, including where you saved the final screenshot.
```
