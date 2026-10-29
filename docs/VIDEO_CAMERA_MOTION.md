# Imported video camera workflow

Video → timeline detects chapter boundaries locally and creates **stationary
placeholder cameras**. It no longer invents the same dolly-in in every chapter.

In AI Generate Scene, imported videos expose Video Camera Motion:

1. Keep **Analyze camera before generating** checked, or use **Analyze / refresh
   video motion** separately. Default: Gemini 3.8 Flash, Low thinking. Alternative:
   Gemini 3.5 Flash-Lite, Minimal thinking. This uses the existing server-side key;
   the billing/free tier belongs to its Google project, not this dropdown.
2. Confirm one potentially billable analysis request. Eleven 400px chronological
   JPEGs cover the selected chapter. No automatic retry or fallback follows a
   timeout, quota error, capacity error or malformed answer. Generation stops
   if this requested analysis fails or is cancelled.
3. The validated estimate saves as `shots[].videoCameraMotion`: normalized
   camera positions, look-at targets, vertical FOV, motion type, confidence and
   uncertainty. This changes no camera keys. Regeneration reuses it for free;
   changing chapter boundaries invalidates it. Refresh explicitly to analyze again.
4. Geometry requests receive fixed motion labels and validated numeric poses
   as context. Existing Standard Argon system prompts remain byte-identical.
5. Once geometry is ready, placeholder-only camera chapters automatically stage
   a fitted video-motion preview. Acceptance saves geometry and camera together;
   uncheck the camera checkbox to retain existing keys. Authored/previously applied
   cameras are never automatically replaced. Choose **Use analyzed video motion**
   and preview explicitly to replace them.
   Fresh drafts retain an original placeholder-key snapshot, so changing a key's
   position, lens, curve or timing disables automatic staging even when its old
   generated marker remains. Older projects without that snapshot use explicit sync.
6. The same video-motion mode is available under Sync Accepted Model Camera.
   It uses the saved estimate and current geometry locally, without another call.

## Framing and persistence

### Correcting a wrong starting angle

Motion analysis and Argon's camera estimate may use different orientations. A
plausible push/orbit can consequently start from the wrong facade. More keys
alone do not fix this. Under **Sync Accepted Model Camera**, two preview tools
correct the whole saved path without regenerating or rotating the model:

- **Match camera to reference · AI** sends three JPEGs (current playhead first)
  and a bounded index of the actual accepted model's object dimensions,
  rotations, positions and repeats. Gemini 3.8 Flash Low or Flash-Lite Minimal
  estimates a reference view in that model's coordinates. This is one separately
  confirmed potentially billable call, with no retry/fallback. The index may omit
  small parts in very large manually authored scenes; actual objects are untouched.
- **Align whole path to current orbit view · Free** lets you pause at a matching
  frame, use Orbit inspect to match the reference yourself, and capture that view.

Both tools apply one uniform camera-path rotation, translation and scale at the
actual matched timestamp, plus a lens offset. They preserve existing key times,
curves and chapter cuts, and freeze `sceneAnchor`. Preview scrubbing first, then
Apply. Until Apply, saved camera keys, geometry and text are unchanged. Matching
uses the accepted scene only, so finish/accept or discard an active proposal first.

New motion analyses sample eleven frames and request 5–11 keys for moving shots.
Existing seven-frame analyses remain valid. To obtain more observations for an
existing chapter, explicitly refresh video motion, preview **Use analyzed video
motion**, then match the reference view. Interpolating extra keys into an old path
alone would not provide new motion evidence. No Argon scene regeneration is needed.

Positions are estimates in subject-radius units with Y up and initial +Z view.
Actual generated bounds provide world scale. When the scene has a suggested
camera and its primary sampled timestamp is known, the trajectory is aligned
to that view **at that timestamp**, even when it is mid-chapter. Otherwise it
uses geometry center/radius; inspect the result. Resumed older jobs have no
reliable reference timestamp and intentionally use the bounds fallback.

`shots[].cameraReferenceAt` records the known primary timestamp on acceptance.
`sceneAnchor` freezes the geometry so fitting never moves the model. Generated
keys use linear segments, preserve chapter cuts and keep the last key one frame
before the next chapter. Timeline JSON, local save, Undo and the existing video
renderer all use the same accepted keys. Clearing/replacing the timeline removes
these per-project estimates with it; no global motion cache exists.

## Cost and limits

One camera analysis runs before geometry, with no parallel chapter fan-out.
It has a separate 20/hour session allowance; geometry's existing allowance is
unchanged. This prevents analysis from consuming geometry request slots in the
PHP editor, but **does not bypass Gemini RPM/TPM/daily/project limits**. A billed
API key cannot be switched to a free billing tier by choosing a model. No live
analysis or account-specific quota/free entitlement has been verified here.

Google documents Gemini 3.8 Flash thinking levels low/medium/high (not minimal):
https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8
Rate limits apply per project and depend on model and tier:
https://ai.google.dev/gemini-api/docs/rate-limits

## Limits of the estimate

Eleven images provide approximate evidence, not optical-flow tracking or a
calibrated camera solve. Ambiguous or unknown motion must return stationary
keys and a low-confidence explanation. Translation, rotation, lens zoom and
independently animated subjects are distinguished by the prompt but still need
visual review. Fast motion or multiple cuts inside a chapter can be missed;
split those chapters and reanalyze. Roll, distortion and exact metric travel
are not represented in the existing position/target/FOV timeline format.

This first implementation targets the single-video workflow. Reference Builder
keeps its current generation behavior. The separate clear-workspace UI is outside
this change.
