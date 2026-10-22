# Particle surface visual QA

## 2026-10-03 mixed-surface color correction (latest)

- Scope: user-approved correction of the existing animated particle palette; not a pixel-identical geometry rebuild.
- Source: `/var/folders/rc/qjqjdhn15fxffdvl9cp_fbg00000gn/T/codex-clipboard-67305467-3048-4fb6-992f-3c6c56348994.png` (1199 × 1696).
- Preview: `http://127.0.0.1:5182/tests/visual/particles.html`.
- Implementation: `/private/tmp/annie-mixed-idle-final.png` (1280 × 720 browser capture); thinking: `/private/tmp/annie-mixed-thinking.png`; executing: `/private/tmp/annie-mixed-executing.png`.
- Full-view comparison: source and final idle screenshot opened together in one comparison input. Source is a portrait artwork; implementation retains the existing landscape app composition. Compare particle color relationships rather than page dimensions. No pixel-exact density normalization is claimed.
- Focused inspection: blue persists through the central/lower surface; violet is visible in separated lateral and upper folds; cyan follows other curved bands, including the lower edge. Color no longer follows a top-to-bottom ramp.
- Typography/copy: source has none; existing app text and state controls remain legible and unchanged.
- Layout/spacing: existing component and responsive layout retained; state controls visible at 1280 × 720.
- Colors: blue base with continuous 3D cyan/violet fields; thinking/executing preserve this palette. Error remains a semantic warm color.
- Image quality: live WebGL points retained as explicitly requested. No raster substitution. Bright folds still have small pale highlights; tighter point density and different silhouette than the source are existing geometry differences outside this correction.
- Iterations: (1) replaced height ramp with spatial bands; (2) tried normal blending to reduce white crests, but back-facing points darkened the surface; (3) restored additive rendering with reduced rear/edge alpha and increased localized violet. Final screenshot captured after full reload.
- Interaction checks: switched idle → thinking → executing → speaking → listening; surfaces render and labels update. Preview uses simulated input level, not microphone audio. Browser console inspection was not available through the simple screenshot interface; no runtime error overlay observed.
- P3 follow-up: refine point density and fold silhouette if closer overall image fidelity is requested. Exact animation cannot be inferred from a static source.
- Acceptance scope: mixed-color correction only.
- final result: passed

## Earlier QA (superseded)

The height-based gradient conclusion below was rejected by the user and is preserved only as history.

## Source visual truth

- Source: `/var/folders/rc/qjqjdhn15fxffdvl9cp_fbg00000gn/T/codex-clipboard-8e037f7a-8262-4e74-83d4-1f7baa86bc3b.png`
- Source pixels: 1200 × 1600
- Target state: idle /待命

## Implementation evidence

- Screenshot: `/private/tmp/annie-particle-gradient-window.png`
- Captured app window content: approximately 2308 × 1530 source pixels, desktop device scale 2
- Comparison region: black app canvas and particle core; surrounding desktop chrome excluded from the visual judgment

## Comparison

- Full-view: the implementation preserves the reference's black field, centered dot-matrix energy surface, irregular folded silhouette, cyan/blue upper field, and violet lower return flow.
- Focused region: the particle core uses a continuous violet → electric blue → cyan vertical gradient with additional depth and crest highlights. The point spacing remains regular and the particles stay crisp rather than becoming a blurred glow.
- Typography, spacing, and app copy are product-owned UI outside the supplied particle reference and were not changed in this pass.

## Findings

- No actionable P0/P1/P2 visual issues remain for this particle-gradient pass.
- P3 follow-up: the reference has a wider, more open side-fold silhouette; this can be tuned later without changing the gradient model.

## Comparison history

1. The first revision was too spherical and suppressed the violet return flow.
2. The current revision restores the folded surface, increases the core scale, and replaces the color mix with a continuous height-based gradient.

## Final result

passed
