# Vintage racecar: legacy vs. current GLTS format

Independent review, Claude Opus 5, 2026-09-04. Neither car was modified for the
comparison. A later publish review replaced unchecked assertions in the current
showcase with explicit guards; its modeling values and rendered appearance are
unchanged. The generation counts below describe the frozen comparison input.

## What was compared

| | Legacy control | Current run |
| --- | --- | --- |
| Format | Drawcall Design GLTS (default-export `THREE.Object3D` class) | Current GLTS (exportless script into a contextual `scene`) |
| Source | recovered from `agent-ad8bfd058670194b0.jsonl`, frame `zwmp0r07pfsbet` | `examples/viewer/public/assets/showcases/vintage-racecar/` |
| Files / lines | 6 / **956** | 6 / **2114** (body 732, chassis 413, cockpit 346, wheel 312, index 192, paddock 119) |
| Build time | ~14.8 min | ~72 min incl. integration, tests, 3 visual passes |
| Renders seen by its author | **none — both screenshot calls timed out** | 3 |

The legacy source was reconstructed by replaying the four `write_design_file`
calls and applying the three `edit_design_file` patches in order. The result is
exactly 956 lines, matching the recorded figure, so the recovery is verified.

The compatibility port lives at
`examples/viewer/public/assets/benchmarks/vintage-racecar-legacy/` and is not
referenced by the viewer. It is mechanical only: **+72 lines of code, −29,
49 lines of new comment, zero changed numeric literals** across 956 lines. Every
profile station, colour, material parameter, transform and camera value is the
legacy value.

Both cars were rendered at 1440×900 through `.artifacts/racecar/shoot.mjs`,
each on its own authored default camera with `isPreview: true`.

## 1. Is there a visual-quality degradation in the current-format result?

**No. The current-format car is clearly the better result**, and the gap is not
close on construction quality.

The legacy car has a genuinely handsome core — a lathed torpedo body, an elegant
boat-tail, and the best single component in either car, its 32-spoke wire wheels
with drums and knock-off spinners. But it carries visible construction defects
throughout, all consistent with never having been looked at:

- **Roundels are broken.** The number plane and the spherical white cap
  intersect: the `12` is clipped and half-buried, and the cap reads as a
  hard-edged white sliver rather than a painted disc. Visible from every angle.
- **Louvers float.** The 36 louver boxes are placed at `halfWidthAt(z) − 0.009`
  on a body whose cross-section is scaled non-uniformly, so they sit half in
  air and half sunk, reading as a row of black ticks rather than vents.
- **The aero screen is detached.** It renders as a flat dark slab standing above
  and forward of the coaming with a visible gap.
- **The cockpit opening is fringed with artifacts.** From above, a dense picket
  of thin dark spikes rings the cut, where the interior tub and the torn
  `cutCockpitOpening` edge fight. The dashboard is a floating brown box.
- **The exhaust tip protrudes through the tail cone** as a chrome stub.
- **The lathe is faceted.** 15 linearly interpolated profile stations produce
  hard shading bands across the whole flank.
- **The radiator reads as a grey slab** stuck onto a nose that pokes out behind
  it, with a visible step where the paint ends.
- **The 196 lines of suspension are almost entirely invisible** — the axles,
  leaf springs, dampers and radius rods sit inside the body envelope.

The current car has none of these. Its louvers are cleanly inset, its roundel is
crisp and correctly seated on the flank, its aero screen has a chrome frame and
a mirror stalk, its cockpit reads as a coherent tub with wood rim, seat and
leather coaming, its chassis tubes and suspension links are visible where they
should be, and its 4-into-1 headers exit and merge properly.

Where the legacy car is genuinely better: its flat four-light rig makes the
whole model legible, and its wire wheels are crisper. The current car's real
weakness is exposure — ACES at 1.08 over a dim environment drops the rear third
and the far flank close to black, and the wheel spokes read as a dark starburst.
That is the one axis where the older result wins.

| Axis | Legacy | Current |
| --- | --- | --- |
| Silhouette / proportion | good (1920s–30s GP) | good (1950s front-engine GP) |
| Modelled detail | high ambition, poorly resolved | high and resolved |
| Construction coherence | poor — parts float, clip, intersect | good |
| Materials | flat; chrome/brass read grey | convincing metal, brass, clearcoat |
| Lighting / staging | none authored — black void, no shadow | ground, contact shadow, fog, backdrop |
| Camera / framing | small in frame, high and distant | fills frame, low and deliberate |
| Visible defects | many, listed above | dark rear third; muddy spokes |

Efficiency, same harness: legacy 94,996 triangles in **606 draw calls**, 104
geometries. Current 196,965 triangles in **84 draw calls**, 43 geometries — 2×
the geometry for 1/7 the calls, from `loadInstancesAsync` on the wheels.

## 2. Format-caused vs. everything else

**No degradation is attributable to the format. The evidence runs the other
way.**

Against a format cause:

- The port is purely mechanical and ran correctly on the first attempt: no
  console errors, no page errors, 295 meshes in both preview and non-preview,
  `defaultCamera` exactly `fov 34 @ (4.4, 2.1, 4.7)`, both the fallback camera
  and an explicit host override rendering, clean disposal. The current format
  expressed the legacy design without redesign.
- The legacy authoring skill documents **no scene-level presentation at all**.
  Its root is a `THREE.Object3D` subclass; the only presentation levers are the
  `previewCamera` and `previewLighting` named exports. No background, fog,
  shadows, tone mapping, environment, effects or instancing appear in it.
  Three of the current car's largest visual advantages — the contact shadow,
  the tone-mapped speculars, and believable chrome/brass/clearcoat from a
  prefiltered IBL probe — come directly from `scene.rendering`,
  `scene.environment` and `scene.background`, which the legacy format did not
  offer. The legacy car's flat grey metal is the predictable consequence of its
  workaround: a raw, unprefiltered 256×128 canvas assigned as `envMap` on every
  material by traversal contributes almost nothing at roughness 0.14–0.30.

The real causes of the gap, in descending order of size:

1. **The legacy run was blind.** Both `get_design_frame_screenshot` calls timed
   out and the agent said so in its final message: *"The frame screenshot
   service timed out twice, so I could not visually verify the render."* Every
   legacy defect listed above — floating louvers, clipped roundel, detached
   screen, cockpit fringe, exhaust through the tail — is exactly the class of
   error that only a render reveals. The current run did three visual passes.
   This alone plausibly accounts for most of the difference.
2. **The prompts asked for different things.** The current prompt says *"This is
   a quality comparison, not a brevity exercise… iterate until it is a polished,
   immediately recognizable vintage racecar"* and *"Build and visually inspect
   your result in the actual viewer."* The legacy prompt said only *"build a 3D
   vintage racecar."*
3. **Budget:** ~14.8 min vs ~72 min.
4. **Sampling variance:** n = 1 per condition. Era (1920s vs 1950s), colour and
   staging were all free choices.

## 3. What this says about current-format capability and ergonomics

**Capability: a superset, on the axes that mattered here.** It absorbed a
956-line legacy design with no design change, and it additionally supports the
staging, tone mapping, IBL and instancing the legacy format could not express.

**Ergonomics: better on presentation and resources, worse on composition.**

The controlled measurement is the port itself — the same design in both formats:
**956 → 1048 lines, +9.6%**, all of it import / instantiate / `onDispose`
plumbing. That is the format's boilerplate tax. The 956 vs 2114 headline gap is
*not* a format tax; it is a different design at a different level of detail,
produced under a different prompt with iteration, and should not be read as one.

Where the current format costs more:

- **Composition became asynchronous.** In the legacy shape a part constructs its
  children inline (`this.add(new Cockpit(), new Exhaust())`, `new Wheel()` in a
  loop). Loads must now happen at top level during evaluation, so both
  `Bodywork` and `VintageRacecar` had to take their children as constructor
  parameters and six loads had to be hoisted. The legacy affordance — import
  once, instantiate as often as you like — is replaced by N loads or
  `loadInstancesAsync`. For a class-per-file design this is genuine friction.
- The legacy skill's rule *"avoid top-level side effects"* is inverted: the
  current format requires them.

Where it costs less:

- `scene.environment` + `environmentIntensity` (2 lines, prefiltered IBL)
  replaces the legacy car's 13-line traverse-and-assign-`envMap` workaround —
  and produces materially better metal.
- `isPreview`, `scene.rendering` and `onDispose` replace hand-rolled equivalents
  or, in the legacy case, capabilities that simply were not available.

## 4. Limitations preventing a stronger causal claim

1. **The confounds swamp the variable.** The two runs differed in prompt, time
   budget, and — decisively — in whether the author could see its own output.
   The legacy run's inability to render makes it impossible to isolate format as
   a cause of anything. This experiment cannot answer the causal question it was
   posed; it can only show that the current format did not *prevent* a better
   result, and that it did not fail to carry the legacy one.
2. **I never saw the legacy host's own render.** The frame screenshots timed out
   and the frame is remote. I judged the legacy design through this repo's
   harness, which supplies a black clear colour and no floor *because the legacy
   asset authors none*. The Drawcall Design viewer may have supplied its own
   background, ground, exposure or tone mapping. My defect list is therefore
   restricted to geometry and construction faults, which are host-independent;
   staging and exposure comparisons are flagged as such and carry less weight.
3. **n = 1 per condition** on a high-variance generative task.
4. **The fixed comparison views were tuned to the current car** (2.28 m
   wheelbase; the legacy car is 2.50 m with a 4.0 m body), so the legacy car is
   framed slightly less flatteringly in the non-default views. The
   default-camera pair is the fair comparison and is weighted accordingly.
5. **Three.js version and renderer settings** in the legacy Drawcall Design host
   are unknown.
6. **The port is faithful but not identical** — see below.

## Semantic differences in the compatibility port

All are non-visual under a preview load; none change a rendered pixel.

1. `previewLighting` is gated on `isPreview` rather than resolved through a
   named export. The condition is equivalent (root preview only, ignored when
   nested), but it is now the loader's flag.
2. `previewCamera` → `scene.defaultCamera`. The legacy host fell back to a
   depth-first camera search and then autofit when the export was absent; it is
   present here, so there is no behavioural difference.
3. Composition is asynchronous. `Bodywork` and `VintageRacecar` receive their
   children as constructor parameters instead of constructing them. **Hierarchy
   and transforms are unchanged**: Cockpit and Exhaust remain children of the
   Bodywork group; bodywork, suspension and four wheels remain children of the
   VintageRacecar group.
4. Four `new Wheel()` calls became four separate `gltsLoader.loadAsync` calls of
   the same file, preserving four independent instances with their own
   geometries and materials. `loadInstancesAsync` was deliberately *not* used —
   it would have shared them.
5. `VintageRacecar.dispose()` no longer traverses to dispose descendant
   geometries and materials; GLTS disposes nested managed nodes recursively. It
   now disposes only what the root owns, the environment texture. Disposal of
   the four preview lights was added; the legacy code never disposed them.
6. Nothing sets `scene.rendering`, matching the legacy format, which had no
   equivalent. The harness therefore renders the legacy car with no tone mapping
   and no shadows. Faithful to the asset; possibly not to the legacy host.
7. Legacy design problems were **not** fixed. The broken roundel, floating
   louvers, detached aero screen, cockpit fringe and protruding exhaust tip are
   all reproduced as authored.

## Scorecard

| Criterion | Legacy | Current | Winner |
| --- | --- | --- | --- |
| Silhouette & proportions | 7 | 8 | current |
| Modelled detail | 6 | 8 | current |
| Construction coherence | 3 | 8 | **current** |
| Materials | 4 | 8 | **current** |
| Lighting & staging | 3 | 7 | **current** |
| Camera & framing | 5 | 8 | current |
| Freedom from defects | 3 | 7 | **current** |
| Legibility of the model | 7 | 5 | legacy |
| Overall finish | 4 | 8 | **current** |
| Authoring ergonomics (same design) | 956 lines | 1048 lines | legacy, by 9.6% |
| Render efficiency | 606 calls | 84 calls | **current** |

**Verdict: no visual-quality degradation from the current format. The current
result is substantially better finished, and the format is a capability superset
for presentation. The experiment cannot attribute the gap to format, because the
legacy run never saw a render of its own work — that confound, not the syntax,
is the best explanation for the difference.**

## Comparison renders

- Legacy port, authored default camera:
  `.artifacts/racecar/legacy/default.png`
- Current, authored default camera (frozen):
  `.artifacts/racecar/shots/default.png`
- Current, real viewer (frozen): `.artifacts/racecar/final-viewer.png`
- Matched fixed views for both: `.artifacts/racecar/legacy/{front-quarter,side,rear-quarter,front,top,cockpit}.png`
  and `.artifacts/racecar/shots/{...}.png`
