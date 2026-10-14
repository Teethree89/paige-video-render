# Phase 2: Editable Primitive Scene Format

This is the **data contract** between the video timeline, Three.js scene builder, the browser editor, future AI vision adapters, and the MP4 renderer.

## State and data flow

The existing project still runs from its original `timeline.json` and original GLBs. For imported videos, every shot has an id such as `draft_001`. Adding editable objects creates the optional `primitiveScenes` property on the **working timeline**, which is saved in browser localStorage and included by **Export timeline**.

```json
{
  "title": "Imported reference",
  "duration": 8,
  "fps": 30,
  "shots": [{"id":"draft_001","start":0,"end":8,"name":"Example"}],
  "camera": [
    {"id":"c1","at":0,"p":[0,5,22],"t":[0,3,0],"fov":55,"cut":false},
    {"id":"c2","at":7.99,"p":[0,5,17],"t":[0,3,0],"fov":53}
  ],
  "text": [],
  "primitiveScenes": {
    "schemaVersion": 1,
    "scenes": [{
      "shotId": "draft_001",
      "objects": [{
        "id": "rack_1", "name": "Equipment cabinet",
        "primitive": "box", "position": [0,3,0],
        "rotation": [0,0,0], "scale": [3,6,2],
        "material": {"color": "#314f63", "metalness": 0.65, "roughness": 0.4}
      }]
    }]
  }
}
```

The standalone **Export JSON** button saves just `primitiveScenes`. Import JSON accepts this document directly or a timeline containing a `primitiveScenes` property. A source MP4 is not embedded in the JSON and must be retained separately.

## Supported objects and properties

Supported primitives: `box`, `sphere`, `cylinder`, `plane`, `torus`. All are editable Three.js meshes. Position and rotation are 3-element numeric arrays. Rotation uses radians. Scale determines dimensions in world units; primitive meshes use unit base geometry. `material.color` is a 6-digit hex string; metalness and roughness are values between 0 and 1.

Shot-specific objects render **only during that shot**. When a draft shot has one or more primitive objects, the generic Phase 1 guide blockout hides automatically. The original hand-built models remain unchanged. Each shot can export its own binary GLB.

## Validation / safety for future AI

The validator rejects unsupported geometry, duplicate IDs, unrecognized shot IDs, nonfinite numbers, invalid materials, and oversized responses. Caps: up to 120 scenes, 200 objects per scene, and 2000 total objects. Names are bounded and inserted into HTML via `textContent`. Extra fields in generated content are ignored. No arbitrary JavaScript, URLs, remote textures, custom shaders or eval.

A future AI model must return a data structure conforming to this contract; **never execute code written by the model**. The model should also attach confidence/explanations in a separate analysis report—not put unsupported keys in the runtime document.

## How to test with the current editor

1. Import a video using **Video → timeline** and click **Use in editor**.
2. Select a shot in the timeline. In **3D Primitive Scene Editor** select **Example room** or add a box/cylinder/etc.
3. Select an object; modify position, rotation, size and material.
4. Use **Orbit inspect** to inspect the shot, or adjust camera keys in the existing camera inspector.
5. Export standalone primitive JSON, the whole timeline JSON, or the current shot's editable GLB.
6. Open **Render video** to preview or export the scene. It uses the same primitive-scene document saved by the editor.

The example room consists of a plane and six boxes. It is **only a generic blockout template** and does not imply the video was interpreted by AI.

## Next phase (not yet implemented)

Use a protected AI adapter to analyze representative video frames, infer *proposed* geometry, and produce validated `primitiveScenes` data for user review. Keep the OpenCode API key in a local process or authenticated backend, **not** in the public FTP-hosted site.
