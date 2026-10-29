# Sync Camera Motion — regenerated chapters

## Video-derived estimates

Imported-video chapters can now use **Use analyzed video motion (estimate)**.
This builds a path from a separately saved video analysis rather than retargeting
the placeholder path. See [VIDEO_CAMERA_MOTION.md](VIDEO_CAMERA_MOTION.md).
The original motion/fit/model-view modes described below still retarget existing
keys and do not themselves recover motion from footage.


## What it solves

New AI-generated geometry can have a different size and world-space center than
the model it replaces. Merely retaining the earlier chapter's camera keys
can put the camera inside the model, far outside the model, or facing empty space.

The editor now uses **the saved camera path** as its motion reference and
**the actual old/new generated Three.js world-space geometry bounds** as
its scale/center reference. This preserves camera direction, pans, pushes,
orbits, FOV, cut boundaries, interpolation curves and keyframe times as
closely as a uniform motion retarget allows.

Unlike an AI-estimated reconstruction from three image frames, this mapping
is deterministic, immediate, locally previewable, and requires no additional
Google API call.

## How to use it

1. Select the chapter you want to regenerate, choose the preferred Gemini
   model and generate editable scene geometry as usual.
2. When the 3D proposal is available, locate **Sync Camera Motion** below
   **View proposed shapes in 3D**.
3. Choose a framing mode:
   - **Preserve original motion & framing** (default): scale/translate every
     chapter camera position and look-at target using exact relative geometry
     bounds. Existing camera motion is retained.
   - **Fit the entire regenerated scene**: additionally move cameras back when
     necessary to include the generated scene's bounding sphere.
   - **Align motion with model's suggested starting view**: rotate the existing
     camera path to face the model-generated estimated view while preserving
     its relative keyframe motion. Requires a valid suggested scene camera;
     the estimate may not reproduce the real source video.
4. Click **Sync & preview camera motion**. This is *free* and does not make an
   additional Gemini request. Scrub/play the timeline to review the suggested
   framing while the generated proposal remains unaccepted.
5. Leave **Apply synchronized camera keys when accepting geometry** checked,
   then click **Accept proposed geometry**. The new geometry and revised camera
   path are committed together, preserving other chapters. Or uncheck it /
   discard the preview to keep original keys and geometry unchanged.

The UI tells you how many camera keys were retargeted and the relative scale.
The saved project records the sync mode/scale on its chapter, and the camera
keys and geometry stay editable. Use Undo if you need to revert the resulting
timeline transaction.

## Technical invariant: freeze the geometry anchor

Paige normally derives each shot's primitive-group world anchor from the
target of the chapter's first cinematic camera key. This is appropriate
for newly generated shot-local geometry, but naive camera synchronization
would shift the **geometry itself** every time the camera target changes.

The synchronization operation therefore writes a stable
`shots[].sceneAnchor` (the exact original anchor) and the shared
`shotAnchorMap` uses it on all future previews, reloads and renders. The
geometry stays in place while the camera is retargeted around it.

For scenes with existing accepted primitives, old-to-new radii set the
scale. When no old accepted geometry exists, the initial authored camera
distance and the new model bounds determine a reasonable reference scale.

The renderer also uses geometry-aware near/far clipping planes, not a
hard-coded 500-unit far plane, so very large accepted environments remain
visible. The standalone video render path now uses the same authored camera
interpolation and clip calculation.

## Safety and limitations

- No AI API calls are issued by Sync Camera Motion itself. Existing
  **Generate 3D scene** calls remain separately billed/confirmed and
  unchanged. Syncing does not modify Worker, PHP, credentials or retries.
- **Sync** adjusts geometry-aware framing of an *existing* camera
  trajectory. It does **not** recover the true camera motion from a reference
  video that has no trustworthy camera keys. Gemini 3.8 Flash can interpret
  image/video sequences, but three sampled frames alone cannot reliably
  recover metric camera translation, focal length and depth. A dedicated
  motion-tracking/structure-from-motion workflow would be needed for that.
- A camera move through an interior may look too distant with **Fit the
  entire regenerated scene**, because that mode aims to contain the full
  bounds. Use **Preserve original motion** for flythroughs.
- Extreme or invalid model bounds fail safely with an explanatory message.
  The original geometry and cameras are not changed.
- Structural editing while an Argon job/proposal is pending remains
  restricted outside this explicit preview/accept transaction.
- Preview the accepted geometry and exported video before final delivery;
  automated tests cannot fully validate visual composition in a browser.

