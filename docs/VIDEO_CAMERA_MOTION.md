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

Camera reference matching supports grouped assemblies as well as individual
primitives. The bounded index includes component transforms, extruded footprints,
repeat spacing and per-instance rotation in the same local axes as the renderer.
The 240-descriptor inference budget includes components and never limits saved
scene objects. No geometry is changed by building this index.

## Source video after refresh

Single-video imports and reattachments save one original file in this browser's
IndexedDB. The timeline keeps only a source ID and filename. Reloading restores
a new local video URL when that ID matches, including playhead synchronization
and source-overlay controls. This does not upload the original or embed it in
exported timeline JSON. Other browsers/devices still need the source file.

If browser storage is unavailable or full, the source continues working for the
current session and the Source tab asks for reattachment after refresh. Older
timelines without a cached source need one reattachment. Missing sources no
longer display the example poster as if it were the imported video; overlay
controls remain visible but disabled until reattachment. Clear workspace also
removes the cached source and preserves the reusable object library.

## Feature-track camera solver (offline harness, 2026-10-29)

`camera-track-solver.js` is a deterministic, local alternative to asking a
model for the camera path. Given 2D feature tracks (`[frame, x, y]` pixels per
track id) it:

1. scans for parallax (rotation-compensated residuals). If a pure rotation fits
   every frame at some focal length, it solves **rotation only** (pan / tilt /
   static) with seeded 2-point RANSAC + Kabsch;
2. otherwise picks the best-parallax frame pair, estimates the essential matrix
   (seeded 8-point RANSAC), triangulates, poses later frames by robust PnP,
   triangulates new tracks as earlier ones die out, and refines everything with
   sparse Huber bundle adjustment (Schur complement over points);
3. estimates the vertical FOV when it is unknown (focal scan + bundle
   adjustment of one shared focal length);
4. converts the result with `trackSolveToVideoMotion` into the SAME validated
   `shots[].videoCameraMotion` v1 estimate (Y up, subject at origin, first
   camera on +Z, ≤11 keys), marked `source:'feature-track'`. The vertical axis
   assumes the camera has no roll. Uncertainty text is a fixed template.

`buildVideoCameraMotion` fits a tracked estimate to geometry exactly like an AI
estimate, but writes `generated:'video-track'` keys and
`cameraSync.source:'feature-track'`. The solve is relative: scale and facing
still come from the generated geometry / reference alignment, and preview +
Apply is still required.

Test it without any video or provider:

```bash
node scripts/camera_track_harness.mjs          # table; exit 1 if any scenario misses its limits
node scripts/camera_track_harness.mjs --json   # machine-readable
node --test tests/test_camera_track_solver.mjs
```

`tests/camera-track-fixtures.mjs` projects a synthetic campus through known
push, pull, truck, pedestal, orbit, pan, tilt, static and crane paths, plus
noisy tracks with 8% outliers and an independently moving object, short
(8-frame) staggered tracks, and unknown 42°/60° FOVs. Errors are gauge-free:
relative rotation, camera centers after a similarity alignment on the
triangulated points, and FOV. Not yet built: the optional click-to-anchor PnP
against accepted geometry.

## Track camera from video (browser, local / free)

Motion tab → **Track camera from video**. For the current chapter it seeks the
local source (the cached single video, or a Reference Builder video clip with
its in/out mapping) at about 12 fps (24–150 frames), draws 480 px wide
grayscale frames, and streams them to `camera-track-worker.js` (module Web
Worker; in-page fallback). `feature-tracker.js` detects Shi-Tomasi corners and
follows them with pyramidal Lucas–Kanade plus a forward–backward check,
re-detecting as features are lost. `camera-track-pipeline.js` keeps ≤30
evenly spaced keyframes, runs the solver and returns the validated estimate.
Nothing is uploaded and no provider is called.

The estimate is saved as `shots[].videoCameraMotion` (`source:'feature-track'`).
With accepted geometry, the Sync panel switches to **Use analyzed video motion**;
an untouched placeholder camera is staged as a preview automatically, authored
keys need an explicit Preview. Apply still writes the keys. Before geometry
exists, AI generation reuses the tracked estimate like an AI one. A source that
cannot seek is refused (it would otherwise look like a static camera).
Still images cannot be tracked: use **Keep camera as is**.

Tests: `tests/test_feature_tracker.mjs` (LK accuracy, keyframes, and rendered
synthetic videos end to end), `node scripts/camera_track_harness.mjs --video`,
and `tests/browser/camera-track-video.mjs`, which decodes the committed
`tests/fixtures/track-orbit.mp4` (regenerate with
`node tests/browser/make-track-fixture.mjs`) in Chromium, then tracks, previews
and applies it in the editor. Limits: dark, blurry, low-texture or heavily
animated shots may fail or be low confidence; lens zoom is not modeled;
the solve is relative (geometry fitting supplies scale and facing).

## Guided chapter workflow

`chapter-workflow.js` adds a four-step guide above the viewport: **1 Choose
workflow** (Video → timeline or Reference Builder), **2 Base models & colors**,
**3 Camera movement**, **4 Name & continue**. Status is derived from timeline
data: a guided (draft) chapter is *pending blocking* until it has accepted
geometry and a non-placeholder camera (AI estimate, track, authored/synced keys,
or an explicit **Keep camera as is**, saved as `shot.cameraConfirmed`). Pending
chapters get a hatched timeline clip and a viewport overlay; generated,
camera-ready chapters ask for a name (`shot.nameConfirmed`, title = upper-case
name) and offer **Save & next chapter**. Overlays hide during AI jobs,
proposals, geometry review and Edit mode. Original authored timelines are not
treated as pending.

### Real footage check (`assets/reference.mp4`, 2026-10-30)

`node scripts/track_video_file.mjs assets/reference.mp4` runs the tracker on each
chapter of the bundled CG reference (needs ffmpeg). This is evidence the tracker
behaves sensibly on real footage, **not** a ground-truth accuracy measurement
(the hand-authored cameras are for a rebuilt scene, so they only confirm the
motion type: e.g. the exterior dolly-in is reported as a push).

| Chapter | Result | Notes |
|---|---|---|
| exterior, pcb, atoms | push | 28–30/30 keyframes, 0.7–1.1 px |
| hall | push | 79/107 frames continuous; the rest held still |
| hallreturn, laser | mixed | 30/30 keyframes, about 1 px |
| fiber | mixed, 46% confidence | few features (303 points), 94/108 frames continuous |
| optics | truck | 65/83 frames continuous; the rest held still |
| finale | refused | fast transition for ~1.5 s, then a locked-off shot; the fit is 3.1 px |

Robustness rules learned from it: a cut or fast transition (most tracks lost at
once) splits the chapter; the longest continuous stretch is solved and the rest
is **held still and said so** in the saved note; if that stretch covers under
half the chapter the track is refused with advice to split. A result is also
refused when under half the keyframes solve or the fit is worse than 2.5 px.
An implausible estimated lens (outside 25–70°) falls back to an assumed 50° when
it fits about as well. Treat tracked paths on CG or heavily graded footage as a
starting point and review the preview.

## Local media expiry (48 hours)

`local-media-store.js` keeps original files in this browser's IndexedDB only:
the single imported video (`paige-source-video-v1`, matched by
`videoIntake.sourceId`) and every Reference Builder image or clip
(`paige-reference-media-v1`, keyed by `mediaId`). Each file expires a fixed
48 hours after it was saved, like a cookie: reading does not extend it,
re-adding or relinking restarts it. Expired files are deleted on read, at
startup and every 30 minutes; files already open keep working until reload.
After a reload, Reference Builder restores whatever is still stored and lists
the rest as RE-LINK. Files are never uploaded; export a portable media ZIP to
keep them longer. Entries saved before this change get a fresh 48 hours.

## Clip library, Keep and versions

Source tab → **Clip library** lists every saved video, clip and image with a
thumbnail (generated once, stored with the file), size, duration, where it came
from and when it is removed. **Keep** stores it indefinitely (and asks the
browser not to evict it; the browser may still decline); unticking starts a
fresh 48 hours. Kept clips survive Clear workspace. Chips show whether the
clip's chapters are **3D** mapped (accepted geometry) and camera mapped
(**CAM**, or **CAM · TRACKED**), how many **versions** exist and whether it is
**IN PROJECT**. Expanding a clip lists the untouched original plus versions
saved automatically when 3D geometry is accepted, camera keys are applied or a
camera is tracked (`clip-history.js`, newest 25 per clip). **Restore** puts a
version's geometry, camera keys and motion estimate back into its chapter as
one undoable edit; resized or missing chapters cannot be restored.
