---
name: GLTS Viewer
description: A cinematic dark workspace for inspecting executable Three.js assets.
colors:
  stage: "#080a10"
  ink: "#f5eee4"
  muted: "#b7afa3"
  faint: "#817b72"
  warm: "#f3b96f"
  edge: "rgba(255, 244, 228, 0.16)"
  panel: "rgba(9, 11, 17, 0.86)"
typography:
  display:
    fontFamily: '"Newsreader Variable", Georgia, serif'
    fontSize: "clamp(1.25rem, 2vw, 1.65rem)"
    fontWeight: 570
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  title:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.8rem"
    fontWeight: 650
  body:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.76rem"
    fontWeight: 400
  label:
    fontFamily: 'ui-monospace, "SF Mono", "Roboto Mono", Menlo, monospace'
    fontSize: "0.61rem"
    fontWeight: 400
spacing:
  viewport-gutter: "clamp(1rem, 2.5vw, 2.25rem)"
  compact-gutter: "0.8rem"
  control-gap: "0.75rem"
components:
  file-drop:
    backgroundColor: "rgba(9, 11, 17, 0.84)"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "13px"
    padding: "0.72rem 0.85rem"
  file-drop-hover:
    backgroundColor: "rgba(23, 20, 18, 0.82)"
    textColor: "{colors.ink}"
  showcase-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "0"
    padding: "1rem 1.1rem"
  showcase-button-hover:
    backgroundColor: "rgba(255, 255, 255, 0.08)"
    textColor: "{colors.ink}"
  showcase-button-selected:
    backgroundColor: "{colors.warm}"
    textColor: "#18120c"
  viewer-dock:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "0"
  status-readout:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
---

# Design System: GLTS Viewer

## Overview

**Creative North Star: "The Cinematic Workbench"**

The rendered Three.js asset owns the viewport. Compact controls sit at the perimeter as translucent, low-contrast chrome, preserving a direct relationship between the user and the live scene.

Warm editorial display type gives the workspace character; restrained sans-serif controls and monospaced telemetry keep it technical. Amber is a scarce interaction signal, while ivory neutrals carry hierarchy without competing with the asset.

**Key Characteristics:**

- Full-bleed live stage with compact perimeter chrome.
- Warm editorial headlines paired with precise technical readouts.
- One amber accent reserved for interaction and active state.

## Colors

The palette is a warm-neutral instrument panel over a nearly black stage.

### Primary

- **Signal Amber** (`warm`): marks file transfer, focus, progress, and the selected showcase.

### Neutral

- **Stage Black** (`stage`): the full-viewport canvas ground.
- **Warm Ivory** (`ink`): primary labels and headings.
- **Muted Stone** (`muted`): supporting copy and secondary metadata.
- **Faint Stone** (`faint`): low-priority trust and helper text.
- **Warm Hairline** (`edge`): quiet division inside translucent chrome.
- **Glass Panel** (`panel`): the dock surface over the live scene.

**The Amber Signal Rule.** Use amber only for actions, progress, and active selection; its rarity keeps state unmistakable.

## Typography

**Display Font:** Newsreader Variable (with Georgia and serif fallbacks)
**Body Font:** UI sans-serif system stack
**Label/Mono Font:** UI monospace stack

**Character:** One compact editorial headline establishes warmth; dense controls remain neutral, and telemetry switches to monospace for machine-readable precision.

### Hierarchy

- **Display** (570, `clamp(1.25rem, 2vw, 1.65rem)`, 1.05): the viewer title only.
- **Title** (650, `0.78–0.8rem`): file and showcase actions.
- **Body** (400, `0.7–0.76rem`): descriptions and live status.
- **Label** (400, `0.58–0.61rem`): telemetry and showcase metadata.

**The Three-Voice Rule.** Use editorial serif for identity, sans-serif for action, and monospace only for technical metadata.

## Layout

The scene and visual staging layers are fixed and full-bleed. The viewer uses a fluid perimeter gutter (`viewport-gutter`), with the masthead at the upper left, the file portal at the upper right, and a centered dock capped at `48rem` along the bottom. The dock divides into one showcase choice and a live readout.

At `720px`, the gutter becomes `compact-gutter`, the file portal spans beneath the masthead, and the dock stacks the readout under the showcase row. At `430px`, secondary masthead copy and the orbit hint disappear while showcase labels may wrap.

**The Stage Owns the Screen Rule.** Chrome stays at the perimeter and never becomes a competing central panel once the asset is ready.

## Elevation & Depth

Depth is a hybrid of dark scrims, translucent panels, backdrop blur, thin warm borders, and restrained ambient shadows. The file portal uses a soft raised shadow (`0 12px 32px rgba(0, 0, 0, 0.22)`); the dock uses a deeper anchoring shadow (`0 18px 50px rgba(0, 0, 0, 0.34)`). Signal glows belong only to progress and status indicators.

**The Bounded Glass Rule.** Every blurred surface needs a visible edge or shadow so it remains legible over unknown asset imagery.

## Shapes

The dock and showcase selectors are rectilinear and edge-aligned. Drag-and-drop surfaces alone use gently curved corners (`13px` for the compact portal and `16px` for the full curtain); status indicators are circular.

## Components

### File Drop Portal

- **Shape:** A dashed, gently curved container (`13px`) with an inline upload icon.
- **Default:** Dark translucent surface, warm-ivory copy, and amber icon.
- **Hover / Focus:** Border turns amber and the panel warms slightly.
- **Transition:** Starts centered during loading, then settles into the upper-right chrome when ready.

### Showcase Choices

- **Shape:** One borderless, square-edged grid cell separated from the readout by a warm hairline.
- **Default:** Transparent surface with a sans-serif title and monospaced descriptor.
- **Hover / Focus:** Gains a quiet ivory wash.
- **Selected:** Amber fills the entire cell with dark brown text.

### Viewer Dock

- **Structure:** A glass panel with one showcase choice and one live readout column.
- **Depth:** Backdrop blur, thin horizontal edges, and the deep anchoring shadow.
- **Responsive:** One row on wide screens; showcase row above readout below `720px`.

### Status Readout

- **Structure:** A small semantic dot, single-line status, monospaced telemetry, and faint trust note.
- **State:** Green means ready, pulsing amber means busy, and coral means error.

## Do's and Don'ts

### Do:

- **Do** keep the rendered asset visible behind every piece of chrome.
- **Do** use amber for interactive focus, progress, and selected state.
- **Do** preserve the serif/sans/mono role split at compact sizes.

### Don't:

- **Don't** turn amber into a general decorative fill.
- **Don't** round the dock or showcase cells; curvature identifies file-drop interactions.
- **Don't** add central chrome after loading that competes with orbiting the asset.
