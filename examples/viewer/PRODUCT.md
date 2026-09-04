# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Inferred from the repository and request: Three.js developers and AI coding
agents evaluating, authoring, or sharing trusted `.glts` assets.

## Product Purpose

The viewer makes a GLTS asset immediately inspectable. Success means a user can
drop a local `.glts` file or choose a bundled example, see its authored preview,
orbit it, and understand whether it loaded and rendered correctly.

## Positioning

Unlike a static model viewer, it executes procedural Three.js source into a
native scene and honors the asset's preview presentation and rendering profile.

## Operating Context

The viewer runs as the repository's example application. Users switch among
bundled examples or drag a trusted local `.glts` file, then inspect the result
with ordinary orbit and zoom controls.

## Capabilities and Constraints

- GLTS is executable trusted code, not a sandboxed interchange format.
- The application owns the renderer, camera selection, controls, viewport, and
  frame loop; a loaded root may recommend `scene.defaultCamera`.
- The loaded root owns preview staging and its optional rendering profile.
- A clear failure state must replace, not obscure, loading or evaluation errors.

## Evidence on Hand

The repository contains the GLTS runtime, authoring skill, browser test harness,
and procedural assets under `public/assets/`. No commercial claims or external
brand assets are available.

## Product Principles

- Put the rendered asset before explanatory chrome.
- Make loading a local source file obvious and immediate.
- Demonstrate distinct GLTS strengths with working source, not feature claims.
- Keep renderer ownership and failure boundaries visible and honest.

## Accessibility & Inclusion

Controls must be keyboard accessible, visible at compact mobile sizes, and
respect reduced-motion preferences.
