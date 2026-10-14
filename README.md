# Atoms to AI — Three.js Sequence Studio

A **working editable 56.47-second 3D flythrough**, structured around the supplied reference video. It reproduces the **visual story and pacing** with procedural 3D objects: nighttime facility → glowing data hall → GaN power circuit → GaCl₃ lattice → server power flow → InP laser source → germanium-doped optical fiber → GGG / SGGG optical isolator → aerial outro.

The reference is *not* being projected on the canvas: the canvas runs a real Three.js scene with a movable camera and keyframes. The result is a **stylized real-time reconstruction of the video's structure**, not a pixel-exact reconstruction of its photorealistic industrial models or VFX.

## Run

1. Unzip the project folder.
2. In a terminal, `cd` into the folder.
3. Run `python3 scripts/reconstruct_media.py && python3 -m http.server 8000` (on Windows: `py -m http.server 8000`).
4. Open `http://localhost:8000` in Chrome, Edge or Firefox.

**An internet connection is needed** for Three.js and OrbitControls, loaded from a pinned jsDelivr CDN. The **video preview is local and embedded** (a compressed copy of the provided video). Do not double-click `index.html`: browser module/fetch restrictions require an HTTP server.

No npm installation or build step is needed.

## Import a reference video and generate a draft timeline (Phase 1)

Use **Video → timeline** in the top toolbar to begin. Choose an MP4, MOV, or WebM that your browser supports, then click **Analyze video & suggest chapters**. By default, the importer compares groups of frames over several seconds to suggest **visual chapters**; switch **Analysis goal** to **Hard cuts** to find abrupt edits instead. Both are pixel-based heuristics, not semantic understanding or reliable scene reconstruction. The chapter mode now checks for a strong, sustained late transition even if earlier scene changes filled the suggestion limit; the final storyboard card always shows an actual ending frame. Change sensitivity, minimum shot length or frame-sample interval, and re-analyze if needed. Name each chapter based on what appears in it, remove false boundaries or **Add boundary at time** before applying.

Click **Use in editor →** to replace the working timeline with estimated chapters and placeholder dolly-camera keyframes. The source clip appears in the synchronized reference-video panel, and newly imported shots get visible **generic guide geometry** while the AI primitive generation phase is developed. The seven original project scenes and the committed default `timeline.json` are unchanged.

Use **Export timeline** or **Download JSON** to retain your shot/keyframe changes. **Keep the original video file too**: the importer uses a temporary browser URL and does not upload or permanently store the source. On reload, JSON/local timeline edits may persist, but the source video must be selected again. Imported shot cuts are only approximate; these are **not** recovered 3D objects or true camera poses.

A full implementation plan for future AI-powered primitive reconstruction, provider benchmarking and camera refinement lives at **[docs/VIDEO_TO_3D_AI_ROADMAP.md](docs/VIDEO_TO_3D_AI_ROADMAP.md)**. AI contributors should start with **[AGENTS.md](AGENTS.md)**. No OpenCode key is required or used by Phase 1.

## Phase 3 prototype — AI-assisted geometry proposals

The GitHub Actions secret `zen_api` is used by a **private runner-side workflow**, not by the publicly hosted editor. The [Zen scene proposal workflow](https://github.com/Teethree89/paige-video-render/actions/workflows/ai-scene-zen.yml) is designed to analyze three frames from an existing chapter of the repository's reference MP4 using the official OpenCode CLI with Muse Contributor Free, validate proposed primitive JSON, and return a downloadable artifact. Unzip the artifact and use **3D Primitive Scene Editor → Import JSON** to review/edit its geometry.

This is a first one-chapter *backend integration test*, not one-click inference for arbitrary browser-uploaded videos. The initial live tests were **blocked by Zen's FREE_TIER_CLIENT_RESTRICTION (403)**, so no AI scene has been generated yet. The original scene and timeline remain safe, and no API key is embedded in public JavaScript. See [setup, privacy and limitations](docs/ZEN_AI_SCENE_PROTOTYPE.md).

## Phase 2 — editable 3D primitive scenes

**The first primitive-building stage is manual and data-driven, not AI-assisted.** Use **Video → timeline** to import and segment a source video. After selecting **Use in editor**, click a shot in the timeline and expand **3D Primitive Scene Editor** under Project settings. Choose **Example room** to get a visible blockout, or add your own box, cylinder, sphere, plane or torus.

Select any object to edit its name, position, rotation, size, color, metalness or roughness. Duplicate or delete objects as needed. The geometry appears only during its corresponding shot, replacing the generic draft guides. Camera animation still uses the normal camera-key timeline; enable **Orbit inspect** to move around the new scene.

Use **Export JSON** to save all primitive scene descriptions, **Export current scene GLB** for a Blender-editable asset, and **Export timeline** to include camera/text tracks and all primitive descriptions in one file. **Import JSON** in the primitive inspector restores compatible primitive descriptions; normal timeline import restores the complete project. The video itself is still a local file, not part of either JSON.

The render-video page uses the **same** scene descriptions, so edits survive through the browser video exporter. The hand-crafted Atoms-to-AI timeline and seven original GLB scenes remain available and unchanged.

See [the primitive scene data contract](docs/PRIMITIVE_SCENE_FORMAT.md) and [the AI roadmap](docs/VIDEO_TO_3D_AI_ROADMAP.md). **AI-generated blockouts and OpenCode model integration are Phase 3**, not yet implemented.

## Controls

The Reset original timeline button is in **Inspector → Project settings**. Playback and editing controls remain disabled until `timeline.json` loads successfully.

- **Space**: play/pause.
- **Click/drag** in the timeline: seek in the flythrough. Reference video seeks along with it.
- **← / →**: move by one 30fps reference frame.
- **Previous / Next**: jump between the 9 reference chapters.
- **Select a diamond on CAMERA**: edit its position, look-at target, FOV, or whether the next scene uses a cut.
- **Orbit inspect**: pause and free-orbit around your current shot. Click **Capture preview camera** with a selected camera keyframe to save that view.
- **+ Camera key**: capture an additional key at the playhead.
- **Select an item in TEXT**: change headline, subtitle, display timing, location, size, alignment, and accent.
- **+ Text**: add a new overlay at the playhead.
- **Delete**: remove a selected camera or overlay key. At least 2 camera keys are kept.
- **Export timeline**: save all edits to JSON.
- **Import JSON**: load your previous JSON export.
- **Reset original timeline**: restore the 27 original camera keys and 13 text overlays.

Changes are also cached in the browser's local storage while editing; always use **Export timeline** when handing edits off to another machine or developer.

## Project structure

```
index.html           UI, viewport, inspector, transport and editor layout
styles.css           Dark studio styling and animated DOM overlay styles
app.js               Three.js player, keyframe interpolation, scrubber and editing logic
world.js             All 3D procedural assets, zones, lights and animation
 timeline.json       Human-readable scene, camera and text timeline
assets/reference.mp4 Compressed reference video synced to the playhead
assets/reference.jpg Reference poster
assets/storyboard.jpg Frame-by-frame reference contact sheet
```

### Timeline data format

Three tracks live in `timeline.json`:

```json
{
  "duration": 56.466667,
  "fps": 30,
  "shots": [{"id":"exterior", "start":0, "end":4.3, "name":"Night campus exterior", "title":"ESTABLISHING THE INFRASTRUCTURE", "tone":"teal"}],
  "camera": [{"id":"c01", "at":0, "p":[75,40,79], "t":[0,3,0], "fov":48, "cut":true}],
  "text": [{"id":"tx01", "start":8.5, "end":11.5, "value":"Headline", "subtitle":"Supporting line", "x":50, "y":38, "size":"medium", "align":"center", "tone":"white"}]
}
```

- `p` is the camera's 3D `[x,y,z]` position; `t` is its 3D look-at target.
- Non-cut camera keys interpolate with smoothstep easing; `cut:true` stops interpolation *into* that key so scenes cut sharply at the annotated timestamp.
- Text positions are canvas percentages, independent of viewport size. Text fades in and out around its in/out points.
- `shots` control scene geometry visibility. Two pairs share geometry: `exterior` + `finale`, and `hall` + `hallreturn`.
- Procedural objects and materials are in `world.js`. For production-level exact fidelity, replace these with textured GLTF scans/models without changing the timeline engine.

## Reference mapping

| Time range | Reconstructed world | Featured text / material |
| --- | --- | --- |
| 0–4.3s | Aerial nighttime data center | Establishing infrastructure |
| 4.3–13.1s | Server hall, copper/teal network conduits | Advanced Materials Inside AI Infrastructure |
| 13.1–17.8s | GaN power circuit board | GaN Power Semiconductor |
| 17.8–20.05s | Atom lattice and crystallization | Gallium Trichloride — GaCl₃ |
| 20.05–23.95s | Server/power flow | Data pathways |
| 23.95–32.2s | InP semiconductor, laser beam and optics | InP-Based Laser, High-Purity Indium |
| 32.2–41.15s | Glass fiber and cyan optical core | Ge-Doped Silica Core / GeO₂ |
| 41.15–48.0s | Garnet crystal isolator | GGG / SGGG, Ga₂O₃ |
| 48.0–56.47s | Return to aerial data center | Advanced Materials Enabling AI Infrastructure |

## Notes

- Rendering uses procedural geometry, additive glow and physical transparency — no external models are required.
- The reference MP4 is only ~1–2 MB and silent to keep the delivery small. It represents the source's visual timing but is not encoded as the final output.
- Original uploaded MP4 is not needed to run the project.
- If the 3D canvas stays blank, check developer console and verify CDN access.

## Troubleshooting

- `app.js:85 Cannot set properties of null (setting onclick)`: the original package omitted `resetBtn` from HTML; corrected in this edition.
- `Cannot read properties of undefined (reading duration)`: a secondary initialization error; playback is now guarded until timeline data is ready.
- A missing `favicon.ico` is cosmetic; this edition provides an inline SVG icon.
- If you still see the old error after replacing files, perform a hard reload (Ctrl+Shift+R / Cmd+Shift+R), or open in a private browser window, to invalidate cached JavaScript.

## External editable GLB models (new)

**Seven GLBs are included and linked into this flythrough by default.** All previous camera, shot, and text timing remains intact. Models reside under `assets/models/{exterior,hall,pcb,atoms,laser,fiber,optics}.glb`. To edit, open a GLB in Blender, export back to the same filename, and use **Reload linked GLBs from folder** in the Inspector. Edits to scene scale, rotation, or local position can be configured in `assets/models/manifest.json`. The original procedural models remain as a fallback if a GLB is missing.

You can also use **Export selected GLB** or **Export all 7 models (ZIP)** to make a fresh, higher-fidelity browser-side export of the exact source geometry from `world.js`. Geometry and persistent model surfaces go in the GLBs; animated glow particles and beams remain separate in Three.js. See [EXTERNAL_MODELS.md](EXTERNAL_MODELS.md) for Blender, Tripo, and relinking instructions.

## MP4 and After Effects delivery

Open **Render video ↗** (top toolbar) for direct browser video recording with live Three.js VFX and optional baked captions. A real-time recording produces an MP4 if available in your browser, otherwise a WebM file (use `convert_to_mp4.sh` / `.bat`). For a native editable AE project, run `AfterEffects/BUILD_EDITABLE_PROJECT.jsx` from Adobe After Effects. **See [VIDEO_AND_AFTER_EFFECTS.md](VIDEO_AND_AFTER_EFFECTS.md) for detailed handoff and limitations.** An immediate offline MP4 preview is also supplied in `exports/flythrough-preview.mp4`.

For FTP publishing secrets and manual deployment, see [GITHUB_AND_FTP.md](GITHUB_AND_FTP.md).

The preview MP4 is stored as seven checksum-verified parts to accommodate upload limits. Run `python3 scripts/reconstruct_media.py` once after cloning; `./start.sh` does this automatically. GitHub Actions also reassembles it automatically for downloadable workspace archives and FTP publishing.

**Zen compatibility:** A direct generic HTTP request produced 403, so the workflow uses the official OpenCode CLI for free-model inference. The CLI still requires a successful live test before AI generation can be considered operational. No paid model is enabled.
