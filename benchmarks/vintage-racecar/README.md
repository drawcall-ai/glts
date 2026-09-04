# Vintage racecar comparison

This benchmark compares independent Opus 5 generations from the same creative
brief across the legacy and current GLTS authoring APIs.

- The legacy control is the “Opus baseline 2” Drawcall Design result.
- Both runs receive the creative brief “build a 3D vintage racecar”.
- Both may use multiple GLTS files and an authored preview camera and staging.
- The current run may inspect and iterate on its own render, but cannot inspect
  the legacy output before it is finished.
- Comparison happens only after the current result is frozen.

The original and mechanically adapted prompts are stored in
[`prompts/`](./prompts/).
