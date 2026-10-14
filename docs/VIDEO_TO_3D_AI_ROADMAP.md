# Video → Editable 3D Flythrough: AI Roadmap

**Project:** Teethree89/paige-video-render  
**Status:** Phases 1–2 implemented; Phase 3 Zen inference prototype (first one-shot experiment), not yet integrated into the browser.  
**Design principle:** Replicate our successful *Atoms to AI* workflow rather than claiming full automatic 3D reconstruction from 2D video.

## Starting point / benchmark

The hand-built 56.466667 s *Atoms to AI* reference has nine chapters, seven procedural Three.js/GLB environments, 27 authored camera keyframes, and 13 text overlays. The models are editable, the timeline is editable, and the browser renderer can record a video. The scenes were **interpreted and manually coded from visual reference**, not objectively reverse-engineered from the movie.

Goal: Import an arbitrary reference MP4; draft shots and frame references; infer semantic structures; generate reusable primitive objects with transforms/materials; suggest 3D camera movement; iterate using matched rendered frames; export GLBs, editable timeline JSON and MP4/AE handoff.

## Phase 1 — Video intake and timeline draft (current implementation)

1. User chooses a local MP4/MOV/WebM supported by their browser.
2. Decode local sampled frames into a small canvas; compare spatial color signatures and luminance histograms to suggest hard scene cuts. Use adjustable sampling, sensitivity and minimum shot length.
3. Provide thumbnail storyboard, manually rename chapter subjects, remove automatically suggested boundaries and insert manual boundaries.
4. Generate valid existing-editor `timeline.json`-compatible `shots`, `camera`, `text`, `duration`, `fps`. Camera keys are **placeholder dolly-in moves**, not recovered pose.
5. Apply as a working draft and sync local reference video. Export JSON; do not change the committed original until intentional commit.
6. Unknown draft shots render generic **guide geometry only**. Do not mislabel guides as inferred objects.
7. Local video blob URLs expire on reload. The exported JSON **does not contain the source video bytes**; persist the source MP4 separately, then link or commit it using an intentional workspace publishing workflow.

Acceptance: current 56 s MP4 imports in a modern desktop browser, shot cards appear, manual cut editing works, playback/scrubbing works, the timeline imports/exports, and the browser video exporter can render the draft guide world. Existing default sequence and seven GLBs remain unaltered. No key required. Cut detection is heuristic and manually reviewed, not guaranteed accurate.

## Phase 2 — JSON primitives engine (implemented: manual authoring)

The implemented **manual** editor validates shot-specific primitive data in an optional `timeline.primitiveScenes` property, renders it through the same runtime as video export, and can export GLBs. The standalone schema is documented in [PRIMITIVE_SCENE_FORMAT.md](PRIMITIVE_SCENE_FORMAT.md). The next phase will generate this exact validated structure from AI vision analysis rather than manual editing.

Example of the underlying data format:

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

## Phase 3 — AI vision and scene reasoning (initial private GitHub Actions prototype)

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

## Phase 1.1 reality-check against the original reference video

A local test on the compressed 56.46-second reference found **one hard-cut candidate around 40.04 s** at the first-pass default threshold of 0.20. Lowering the hard-cut threshold generated many extra boundaries that still did not align with the nine hand-authored story chapters (start times 0, 4.3, 13.1, 17.8, 20.05, 23.95, 32.2, 41.15, 48 seconds). A pixel-change detector is inherently incapable of recreating the original semantic classification and the seven custom procedural 3D environments.

Phase 1.1's windowed visual-chapter mode and editable names make the storyboard review more practical, but should never be described as AI subject understanding. A genuine equivalence test to the manual result requires Phase 2 JSON primitives plus Phase 3 vision-capable semantic scene analysis, then camera refinement.

## Phase 1.2 — Ending / outro coverage

A frame-by-frame check of the original source confirms the final aerial campus/title shot appears around 48–49 seconds and continues through 56.47 seconds. Earlier chapter detection ranked the bright optical changes at about 46.5 seconds higher and its early-in-shot thumbnail showed server equipment, hiding the closing shot. The visual-chapter detector now considers strong **sustained late transitions** when its candidate quota is filled (with safeguards against isolated flash frames); final-shot thumbnails use the middle of the scene and explicitly show the last actual sampled video frame. This is general video behavior, **not** a hardcoded 48-second cut or semantic recognition of an outro. Test with the original video and inspect the reported segment boundaries in the browser.

### Phase 2 actual delivery

- [x] Versioned JSON primitive document with bounded whitelist and validation.
- [x] Per-shot box, sphere, cylinder, plane and torus geometry rendering.
- [x] Editable position, rotation, dimensions and PBR color/metalness/roughness.
- [x] Local save, standalone JSON import/export, timeline JSON persistence, single-shot GLB export.
- [x] Same data-driven primitive world in editor preview and MP4 renderer.
- [x] CI schema tests and public FTP packaging.
- [ ] AI vision-driven scene proposals (Phase 3).
- [ ] Automated video-derived camera recovery (Phase 4).


### Implementation checkpoint

The first Phase 3 adapter is described in [ZEN_AI_SCENE_PROTOTYPE.md](ZEN_AI_SCENE_PROTOTYPE.md): it reads the `zen_api` secret only inside GitHub Actions, sends three extracted frames from the already-public reference video, and validates an importable `primitiveScenes` JSON artifact. It is a backend benchmark, not a public browser button or a complete scene-reconstruction solution. Only the free Muse Contributor variant is allowlisted until its actual image support is verified.
