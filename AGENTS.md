# AI contributor instructions — Paige Video Render

For any video-to-3D work, **read [docs/VIDEO_TO_3D_AI_ROADMAP.md](docs/VIDEO_TO_3D_AI_ROADMAP.md) first**.

Mission: preserve the hand-authored *Atoms to AI* flythrough as the benchmark while building a reusable Video → Shot Timeline → 3D Primitives → Camera Flythrough → Video Export pipeline.

Implemented through Phase 2: offline video intake, visual chapter suggestions, editable storyboard review, draft timelines, and **manual, data-driven primitive geometry** with shot-specific editing and GLB export. AI inference of object identity, positions, lighting, and camera motion is **not implemented**. Read [docs/PRIMITIVE_SCENE_FORMAT.md](docs/PRIMITIVE_SCENE_FORMAT.md) before building the model adapter.

Provider decisions: keep model adapters replaceable. Muse/MiMo/OpenCode free-tier assumptions must be verified against available vision APIs before connecting. Keep provider secrets out of browser JS and public FTP files. Do not store user-uploaded video or send frames to third parties without explicit, informed user action.

Engineering:
- Do not change existing original `timeline.json` or seven GLBs as side effects of import.
- Maintain `shots`, `camera`, `text` timeline compatibility with both app.js and render.js.
- Generated primitive descriptions must be validated data, never arbitrary model-generated JS executed in the browser.
- Treat scene-cut detection and camera estimates as reviewable suggestions.
- Test existing workspace and new deterministic cut-detection tests before merging.
- Browser video uploads are local object URLs and cannot automatically persist to FTP/GitHub.
- Do not disable or overwrite FTP publishing safety settings while editing video features.

## Phase 1.1 distinction

The two video-analysis modes are **hard cuts** (adjacent image changes) and **visual chapter candidates** (windowed novelty). Neither infers object identity, camera pose, or geometry. The original nine-chapter map was manually interpreted; do not try to reproduce it by hardcoding segment counts or expected timestamps for arbitrary videos. Keep storyboard subject labels user-editable, and keep generated camera paths marked as placeholders until the semantic-model stage is verified.

## Phase 3 Zen proof-of-concept

Read [docs/ZEN_AI_SCENE_PROTOTYPE.md](docs/ZEN_AI_SCENE_PROTOTYPE.md). A GitHub Actions **runner-only** script sends 3 frames from the public example MP4 to the free Muse Contributor model via the documented Responses endpoint. It produces a strictly validated, importable JSON artifact. The **website is NOT connected to the provider**; never expose `zen_api` in JavaScript. Model endpoint multimodal compatibility is unverified until the first live Actions run. No automatic overwrite of the original scene.

The first raw HTTP Zen Responses test got HTTP 403 with the configured secret. For free models the workflow now uses the official `@opencode/cli` client (no fake headers, no paid fallback). Confirm real CLI success from Actions before advertising working AI geometry.
