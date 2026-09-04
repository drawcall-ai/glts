# Independent Opus comparison prompt

```text
You are an independent reviewer using Claude Opus 5. Determine whether the
current GLTS syntax/format caused a visual-quality regression in the vintage
racecar benchmark.

The new generation is frozen. Do not edit anything under
examples/viewer/public/assets/showcases/vintage-racecar, the viewer application,
the GLTS package, or skills/glts. Do not creatively improve either car.

The exact legacy Opus run is stored at:
/Users/bela/.claude/projects/-Users-bela-Documents-drawcall-ai-projects-cloud-design/2c68037e-4c08-4366-b8fa-4d8412922cf2/subagents/agent-ad8bfd058670194b0.jsonl

Its final result is the six files written to frame zwmp0r07pfsbet. Recover the
complete source from the write_design_file and three edit_design_file tool
calls in that transcript. Preserve its geometry, materials, transforms,
lighting, environment, and authored camera numerically. Make only the
mechanical changes needed to run it under the current API, placing that hidden
compatibility copy under:
examples/viewer/public/assets/benchmarks/vintage-racecar-legacy/

Read skills/glts/SKILL.md for the current API. A straightforward port may keep
each legacy class as a local non-exported class, instantiate it into the
contextual scene, and replace root static imports with contextual gltsLoader
loads. Map previewCamera to scene.defaultCamera and add previewLighting only
when isPreview. Keep the compatibility copy out of the viewer navigation.
Document every unavoidable semantic difference; do not silently fix legacy
design problems.

Render both cars through the same current GLTS test harness at 1440x900, using
each car's authored default camera and preview staging. You may reuse
.artifacts/racecar/shoot.mjs. Store the legacy render under
.artifacts/racecar/legacy/ and compare it to the frozen current render under
.artifacts/racecar/shots/default.png and the real-viewer capture at
.artifacts/racecar/final-viewer.png. Verify that the compatibility port loads
without console/page errors.

Review the images critically. Compare silhouette and proportions, modeled
detail, construction coherence, materials, lighting/staging, camera/framing,
visible defects, and overall finish. Do not use line count as a proxy for
quality. Also compare authoring ergonomics using the two source trees and the
recorded build facts: legacy 956 final lines and about 14.8 minutes; current
source line counts should be measured, and its completed CLI run took about 72
minutes including integration, tests, and three visual passes.

Write a concise evidence-based verdict to
benchmarks/vintage-racecar/comparison.md. It must answer directly:

1. Is there a visual-quality degradation in the current-format result?
2. If so, which differences are plausibly format-caused versus prompt,
   workflow, iteration, or sampling variance?
3. What does this test say about current-format capability and ergonomics?
4. What limitations prevent a stronger causal claim?

End with a compact scorecard and the paths to both comparison renders. Run any
focused verification needed, then report your verdict and files created.
```
