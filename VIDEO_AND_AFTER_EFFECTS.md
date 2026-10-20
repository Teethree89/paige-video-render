# Video delivery & editable After Effects handoff

There are **two video render paths**:

1. **Best-looking export from Three.js:** Start `python3 -m http.server 8000`, open `http://localhost:8000/index.html`, then click **Render video ↗**. The separate renderer uses the seven linked `assets/models/*.glb` files, live Three.js lighting, optical beams, particles, and the same saved timeline. Select 1280×720 or 1920×1080 and 24/30 fps. To make an After Effects background, **uncheck "Burn editable timeline titles into video"** before recording. This leaves all 13 captions fully editable in AE. It records in real time; **keep the browser tab visible until finished**. Chrome/Edge may offer an MP4 container; if not, it exports WebM. Convert with `convert_to_mp4.sh yourfile.webm` or drag the WebM onto `convert_to_mp4.bat` (FFmpeg required). The browser only exports local video (no original video audio).
2. **Included offline draft MP4:** `exports/flythrough-preview.mp4` (960×540, 24fps, 56.50 seconds). It's an actual render using the linked GLB geometry, exact shot/camera schedule, and baked text. **It is not the Three.js renderer**; the lighting, glows and particle FX will differ. This is for immediate offline viewing and editorial timing checks.

## Export directly from the live editor

Choose **Export timeline ▾** in the editor header and select:

- **Timeline JSON (.json):** exports only the live edited camera, shot, caption, and accepted primitive data. It is a backup and can be imported back into the editor.
- **After Effects package (.zip):** exports that same timeline as `timeline.json`, the matching `AfterEffects/BUILD_EDITABLE_PROJECT.jsx`, all seven **currently displayed** editable scene GLBs, a model manifest, and a readme. Accepted custom primitives export as shot-specific `assets/shots/shot-XX.glb` assets and take priority over legacy model geometry in the corresponding AE workspace.

The ZIP is assembled in the browser. It includes imported GLB model replacements being previewed in the current editor session, but does **not** export unaccepted AI geometry. Accept or discard an AI proposal first. The package does **not** contain an .aep project, a reference MP4, or the Three.js runtime FX: AE must run the JSX to build a fresh editable .aep. Retain the original video separately if you need a background plate. The source camera and model scale conversions still need visual inspection in AE.

## Create a native After Effects `.aep`

**Requirements:** Adobe After Effects 24.1+ is recommended for direct GLB import. Its 3D materials/render pipeline differs from Three.js. See [Adobe's GLB import documentation](https://helpx.adobe.com/after-effects/desktop/import-files/import-and-add-3d-models/import-3d-model.html).

1. Unzip the entire package; do not split the `assets`, `AfterEffects`, `exports`, and `timeline.json` directories.
2. In After Effects, open **File → Scripts → Run Script File…** and select `AfterEffects/BUILD_EDITABLE_PROJECT.jsx`.
3. It creates a **new, non-overwriting** project named `AfterEffects/ATOMS_TO_AI_EDITABLE_CLEAN_YYYYMMDD_HHMMSS.aep` on your computer, with a full-HD 30fps master composition, markers for all nine scenes, editable text title/subtitle layers, 7 imported GLB project assets, nine shot workspaces, and **seven dedicated MODEL CHECK inspection compositions**. Folders are nested under `ATOMS TO AI — GENERATED PROJECT` instead of duplicating root folders. The camera references are **approximate** AE axis conversions and are for reworking the scene, not pixel-exact reproductions of Three.js.
4. By default the included offline preview has text baked in, so the script creates editable title layers **disabled** to prevent doubling the captions. To have enabled editable titles over a clean plate, export the 3D-only movie from **Render video ↗**, convert to H.264 MP4 if needed, save it under `exports/` with a filename beginning `Atoms-to-AI-clean-` and ending `.mp4`, and **rerun the builder** (preferably in a new AE project).
5. If you update the timeline in the editor, click **Export timeline** and replace `timeline.json` in the package before running the JSX script. The browser also reads locally saved edits; AE builder deliberately reads the JSON on disk.

### If the scene appears blank, tiny, or incorrectly zoomed

The previous builder imported scene-local GLBs at 100% AE layer Scale but multiplied their camera positions by **18**. This mismatch can put the geometry at a tiny fraction of its intended size. The revised builder applies a shared **18 AE pixels per Three.js world unit** conversion to both the model layer (1800% Scale as an initial estimate) and camera positions/targets. It now also derives keyframed AE Camera Zoom from each source Three.js **vertical** field of view. These are starting-point conversions; actual AE GLB import Model Settings and material behavior may differ by version.

1. **Use File → Scripts → Run Script File… with the updated `AfterEffects/BUILD_EDITABLE_PROJECT.jsx` from a newly downloaded workspace.** If AE has any existing project items, the script asks to open a fresh project instead of appending another duplicate group; canceling leaves existing items untouched.
2. Open `ATOMS TO AI — GENERATED PROJECT → 04 — Model inspection (camera checks) → MODEL CHECK — exterior` (or `pcb`, `laser`, etc.) first. These static, editable views do not depend on the shot camera and provide a neutral camera overview for model size/visibility.
3. Ensure each composition uses **Advanced 3D** (Composition Settings → 3D Renderer). The script tries to switch automatically, but some AE versions require it manually.
4. If a model is still too small, huge, behind the camera, or invisible, select its 3D model layer and choose **Layer → Model Settings**. Use **Y Up**, verify the Z axis orientation, and try **Make Comp Size** or adjust Object Scale. Adobe's import settings define the base size that AE subsequently calls 100% layer Scale; the script cannot reliably know that base scaling from a GLB.
5. In `02 — 3D scene workspaces`, select the camera and adjust **Camera Options → Zoom** if you need a tighter composition. The script now imports the timeline FOV instead of leaving AE's default focal length.
6. The source video background and the AE camera workspaces are **not** automatically composited into the master—the nine workspace comps are separate, editable reference scenes. To get a finished master movie with the original live Three.js effects, render a clean plate in the browser and use the AE master for editable captions.

The original, already-duplicated `.aep` is not modified in place. Preserve it as a backup and use the generated `_CLEAN_` project for the corrected hierarchy.

### If the model size is correct but the camera points away or jumps between scenes

The builder uses the source Three.js camera's position, look-at target and vertical FOV, converting the scene's X origin to its local GLB coordinate space. In AE, camera auto-orientation depends on the last camera type selected by the operator. On older builds, a camera created as **One-Node** can accept Point of Interest keyframes without following them. The updated builder explicitly chooses **Orient Towards Point Of Interest (Two-Node)** for both each shot and the model inspection cameras.

The earlier builder also sampled the pose exactly at each shot's **out-point**. If that timestamp is an immediate cut, the previous workspace accidentally acquired the next scene's camera pose (potentially hundreds of world units away). The builder now stops at the last visible frame of the shot, before the cut.

Recreate the AE project with the updated JSX in a fresh project (the existing AEP is intentionally not overwritten). In a generated `[3D WORKSPACE]` composition, select the **Camera path reference** layer and verify **Layer → Transform → Auto-Orient → Orient Towards Point Of Interest**. Check framing at the **start, middle, and last visible frame** of each shot, not at its out-point. For an initial coordinate sanity check, the exterior starts with camera Position approximately `[2310, -180, -1422]` and Point of Interest `[960, 486, 0]` when using the builder's fixed 18-pixel conversion. The hall begins around Position `[960, 342, -756]` with Point of Interest `[960, 450, 630]`.

If the camera aims correctly at these locations but the GLB is still displaced relative to the target, check **Layer → Model Settings**, model units, Y-up setting, model origin, and any re-centering applied on import. The builder cannot infer an importer's modified model origin from `timeline.json`; this final model-registration check must happen inside After Effects.

### Troubleshooting After Effects builder errors

The previous `BUILD_EDITABLE_PROJECT.jsx` could fail with **"Object of type Error found where a Number, Array, or Property is needed"** at the camera-workspace setup line. That was a **secondary error** from interpolating a native ExtendScript `Error` into a log string; it hid the original camera API failure. The script also requested an invalid camera Point of Interest match name, `ADBE Point of Interest`. For AE cameras, the property is addressed through `ADBE Anchor Point` in the Transform group. Both are now fixed.

Download the **latest** `AfterEffects/BUILD_EDITABLE_PROJECT.jsx` and replace the older copy in your locally extracted project before running it. If using the workspace ZIP, download a newly published ZIP after this fix is merged; old ZIPs contain the old JSX.

If your AE version or renderer rejects a camera or GLB, the builder reports a **warning with the actual error message** and continues creating the editable project. The final dialog shows warnings and whether the `.aep` was saved. For any fatal error it now reports the stage and underlying message rather than throwing again from its error handler.

Keep `timeline.json`, `assets/`, `exports/`, and `AfterEffects/` together. We statically validate the JSX and its camera/catch patterns in CI, but cannot run Adobe After Effects inside GitHub Actions: the final compatibility test is rerunning the script in your local AE installation.

### What remains editable

- Text: title content, styling, position, timing, opacity transitions, subtitles
- 3D: original seven GLBs (re-edit models in Blender/Tripo, then replace in AE), per-shot 3D scene workspaces, approximate keyframed camera guides
- Timing: scene markers, original `timeline.json`, camera timing
- Footage: replaceable video background in AE

### What doesn't translate automatically

- Three.js point lights, realtime materials, glow sprites, particles, laser beam shaders, render style, and exact screen-space camera interpolation are **not** reproduced in native After Effects by importing a GLB.
- A `.jsx` file is an **After Effects project builder**, not a saved `.aep`. It produces the `.aep` when executed inside After Effects, which is not installed in this build environment.
- MP4 preview is not a substitute for a final Three.js render. For deliverables, use the integrated browser-based recorder.


### GLTF import units and camera registration

AE's default GLTF meter import converts one source unit to 512 native pixels.
This was measured against the supplied AE 2026 AEPX and its export GLBs: the
hall's 53.010517 source-unit width becomes 27141.384766 native pixels. A model
layer at 1800% therefore makes the geometry 512 times larger than the camera
coordinate conversion expects. The builder now uses **3.515625%** model layer
Scale (`18 / 512 * 100`) while cameras remain at **18 pixels per world unit**.
This applies to both MODEL CHECK and shot workspaces, including custom GLBs.

Keep Model Settings at default meter units, Y Up and Flip Z enabled. Do not
use **Make Comp Size** or a separate model-only fit: those alter the registration.
A different import Object Scale/Model Units setting requires matching calibration;
the builder does not discover or reset those settings through an undocumented API.
Rebuild from a freshly extracted export into a new project; previous AEP edits
are not overwritten. Inspect the rebuilt result in AE; automated API-double tests
do not visually validate Advanced 3D rendering.

The supplied AEPX's closing campus workspace referenced `hall.glb`, but the exact
supplied ZIP's timeline and builder map `finale` to `exterior.glb`. Executing the
complete builder against an AE API double preserves the expected nine-shot model
mapping. That discrepancy is not yet reproduced inside After Effects.
