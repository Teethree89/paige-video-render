# Video → Editable 3D Flythrough: AI Roadmap

**Project:** Teethree89/paige-video-render  
**Status:** Phase 1 underway; future AI stages are proposals, not completed features.  
**Design principle:** Replicate our successful *Atoms to AI* workflow rather than claiming full automatic 3D reconstruction from 2D video.

## Starting point / benchmark

The hand-built 56.466667 s *Atoms to AI* reference has nine chapters, seven procedural Three.js/GLB environments, 27 authored camera keyframes, and 13 text overlays. The models are editable, the timeline is editable, and the browser renderer can record a video. The scenes were **interpreted and manually coded from visual reference**, not objectively reverse-engineered from the movie.

Goal: Import an arbitrary reference MP4; draft shots and frame references; infer semantic structures; generate reusable primitive objects with transforms/materials; suggest 3D camera movement; iterate using matched rendered frames; export GLBs, editable timeline JSON and MP4/AE handoff.

## Phase 1 — Video intake and timeline draft (current implementation)

1. User chooses a local MP4/MOV/WebM supported by their browser.
2. Decode local sampled frames into a small canvas; compare spatial color signatures and luminance histograms to suggest hard scene cuts. Use adjustable sampling, sensitivity and minimum shot length.
3. Provide thumbnail storyboard. Allow removing automatic cuts and inserting manual cuts.
4. Generate valid existing-editor `timeline.json`-compatible `shots`, `camera`, `text`, `duration`, `fps`. Camera keys are **placeholder dolly-in moves**, not recovered pose.
5. Apply as a working draft and sync local reference video. Export JSON; do not change the committed original until intentional commit.
6. Unknown draft shots render generic **guide geometry only**. Do not mislabel guides as inferred objects.
7. Local video blob URLs expire on reload. The exported JSON **does not contain the source video bytes**; persist the source MP4 separately, then link or commit it using an intentional workspace publishing workflow.

Acceptance: current 56 s MP4 imports in a modern desktop browser, shot cards appear, manual cut editing works, playback/scrubbing works, the timeline imports/exports, and the browser video exporter can render the draft guide world. Existing default sequence and seven GLBs remain unaltered. No key required. Cut detection is heuristic and manually reviewed, not guaranteed accurate.

## Phase 2 — JSON primitives engine

Define a *versioned and validated* scene schema, separate from camera/text timeline:

```json
{
  "schemaVersion": 1,
  "scenes": [{
    "shotId": "draft_001",
    "objects": [{
      "id": "rack-01",
      "primitive": "box",
      "position": [0, 2, 0],
      "rotation": [0, 0, 0],
      "scale": [1, 4, 2],
      "material": {"color": "#283c55", "metalness": 0.5, "roughness": 0.5}
    }]
  }]
}
```

Allowed primitive whitelist: boxes, planes, spheres, cylinders, torus, tube paths, grouped/repeated instances; capped complexity and dimensions. Validate finite numbers, per-shot object counts, colors and IDs; never eval model-generated code. Render and edit scene objects in inspector. Export approved primitives to GLB.

## Phase 3 — AI vision and scene reasoning

Provider-agnostic pipeline: extract a few representative frames per shot; ask a **verified vision-capable model** to describe visible objects, relative depth, layout, dimensions and repetition, explicitly tagging **unknown** geometry and confidence; convert that bounded semantic description to scene JSON. Avoid pretending image-only evidence provides hidden surfaces or exact metric scale.

Candidates to **test**, not assumed to work: OpenCode Zen free models such as Muse/MiMo when enabled and image-capable. Model availability, free quotas, endpoint image compatibility and acceptable data-use terms change over time. Other providers such as Gemini may require separate credentials. Benchmark models on the same source frames, schema and runtime limits before selecting a default.

**Never put an OpenCode API key into the publicly FTP-hosted JS, localStorage, URL, or repository.** Run AI calls through a local process or authenticated backend, using server-side secrets. Keep Phase 1 offline and independent of API availability.

## Phase 4 — Camera reconstruction, visual QA and iteration

- Use simple motion/flow heuristics to **suggest** pans, pushes and rotations, then optionally AI-assisted estimates. Mark all as estimates.
- For each shot, compare representative rendered views to input frames: framing, silhouettes, dominant color, approximate object placement and motion continuity.
- Emit structured QC reports and allow constrained iterations. Prevent z-fighting, missing objects, view-through glitches, extreme camera velocities and unseen geometry.
- Keep human approval for scene interpretation and replacement of hand-built assets.

## Phase 5 — Complete project publishing

Export `timeline.json`, `primitives.json`, GLBs, thumbnails/storyboard, input-video linkage, MP4, After Effects project-builder sources and manifest. Validate export before publishing. GitHub commits trigger the existing FTP deployment. Uploaded video storage must be explicit; the static FTP site cannot securely hide provider keys or write changes back to GitHub on its own.

## Model comparison scorecard

Compare each candidate with the exact same frames, metadata, instructions and output constraints:
- 25% scene/camera-cut and semantic object recognition
- 30% primitive geometry and relative spatial layout
- 25% camera timing/framing resemblance
- 20% valid, editable schema and code compatibility

Include latency, price at test time, image-input support, context limits, retries, hallucination rate and content/data policy separately. Scores are not yet measured; do not invent success percentages.

## Out of scope for the first milestone

Native video-to-mesh reconstruction, photorealistic texturing, facial identification, automated cloud frame uploads, OCR-derived text overlays, physically exact camera tracking, and production-authored After Effects project generation. These need additional work and validation.

## Files and contributor guidance

`shot-analysis.js`: pure frame signatures, cut detector, timeline draft.  
`video-import.js`: browser-local video decode, storyboard review, JSON apply/export.  
`draft-world.js`: explicitly generic placeholders for imported shots.  
`app.js` / `render.js`: editor and browser output integration.  
`AGENTS.md`: AI coding agent entry point to this plan.

When expanding, keep `timeline.json` backward compatible, do not replace the original seven procedural scenes, prefer deterministic tests and honor the deployed FTP site's security limitations.
