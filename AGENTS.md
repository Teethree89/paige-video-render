# AI contributor instructions — Paige Video Render

For any video-to-3D work, **read [docs/VIDEO_TO_3D_AI_ROADMAP.md](docs/VIDEO_TO_3D_AI_ROADMAP.md) first**.

Mission: preserve the hand-authored *Atoms to AI* flythrough as the benchmark while building a reusable Video → Shot Timeline → 3D Primitives → Camera Flythrough → Video Export pipeline.

Current implemented milestone is Phase 1: offline browser video intake, approximate cut detection, editable storyboard review, generated draft timeline, and **guide geometry only**. Do not claim that shot detection, primitive positions, or camera paths are fully AI-reconstructed.

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
