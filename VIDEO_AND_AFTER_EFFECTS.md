# Video delivery & editable After Effects handoff

There are **two video render paths**:

1. **Best-looking export from Three.js:** Start `python3 -m http.server 8000`, open `http://localhost:8000/index.html`, then click **Render video ↗**. The separate renderer uses the seven linked `assets/models/*.glb` files, live Three.js lighting, optical beams, particles, and the same saved timeline. Select 1280×720 or 1920×1080 and 24/30 fps. To make an After Effects background, **uncheck "Burn editable timeline titles into video"** before recording. This leaves all 13 captions fully editable in AE. It records in real time; **keep the browser tab visible until finished**. Chrome/Edge may offer an MP4 container; if not, it exports WebM. Convert with `convert_to_mp4.sh yourfile.webm` or drag the WebM onto `convert_to_mp4.bat` (FFmpeg required). The browser only exports local video (no original video audio).
2. **Included offline draft MP4:** `exports/flythrough-preview.mp4` (960×540, 24fps, 56.50 seconds). It's an actual render using the linked GLB geometry, exact shot/camera schedule, and baked text. **It is not the Three.js renderer**; the lighting, glows and particle FX will differ. This is for immediate offline viewing and editorial timing checks.

## Create a native After Effects `.aep`

**Requirements:** Adobe After Effects 24.1+ is recommended for direct GLB import. Its 3D materials/render pipeline differs from Three.js. See [Adobe's GLB import documentation](https://helpx.adobe.com/after-effects/desktop/import-files/import-and-add-3d-models/import-3d-model.html).

1. Unzip the entire package; do not split the `assets`, `AfterEffects`, `exports`, and `timeline.json` directories.
2. In After Effects, open **File → Scripts → Run Script File…** and select `AfterEffects/BUILD_EDITABLE_PROJECT.jsx`.
3. It creates and saves `AfterEffects/ATOMS_TO_AI_EDITABLE.aep` on your computer, with a full-HD 30fps master composition, markers for all nine scenes, 13 editable text title pairs (and subtitles), 7 imported GLB project assets, and one workspace composition per shot. The camera references are **approximate** AE axis conversions and are for reworking the scene, not pixel-exact reproductions of Three.js.
4. By default the included offline preview has text baked in, so the script creates editable title layers **disabled** to prevent doubling the captions. To have enabled editable titles over a clean plate, export the 3D-only movie from **Render video ↗**, convert to H.264 MP4 if needed, save it under `exports/` with a filename beginning `Atoms-to-AI-clean-` and ending `.mp4`, and **rerun the builder** (preferably in a new AE project).
5. If you update the timeline in the editor, click **Export timeline** and replace `timeline.json` in the package before running the JSX script. The browser also reads locally saved edits; AE builder deliberately reads the JSON on disk.

### What remains editable

- Text: title content, styling, position, timing, opacity transitions, subtitles
- 3D: original seven GLBs (re-edit models in Blender/Tripo, then replace in AE), per-shot 3D scene workspaces, approximate keyframed camera guides
- Timing: scene markers, original `timeline.json`, camera timing
- Footage: replaceable video background in AE

### What doesn't translate automatically

- Three.js point lights, realtime materials, glow sprites, particles, laser beam shaders, render style, and exact screen-space camera interpolation are **not** reproduced in native After Effects by importing a GLB.
- A `.jsx` file is an **After Effects project builder**, not a saved `.aep`. It produces the `.aep` when executed inside After Effects, which is not installed in this build environment.
- MP4 preview is not a substitute for a final Three.js render. For deliverables, use the integrated browser-based recorder.
