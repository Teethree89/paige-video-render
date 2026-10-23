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

Every object has `id`, `primitive`, `position`, `rotation` (radians, Euler XYZ), `scale` and `material` (`color` as `#RRGGBB`, `metalness` and `roughness` from 0 to 1); `name` and `layer` are optional. Before scale, every solid primitive fills a 1×1×1 cube centered on its position (a plane is flat, and a torus ring is about 1.08 across), so `scale` is its full size in world units (0.01 to 2,000 per axis, enough for a full scene's ground) and a part resting on the ground has `position[1] = scale[1]/2`.

| Primitive | Unit shape and orientation | Typical use |
| --- | --- | --- |
| `box` | cube | walls, slabs, panels, racks |
| `sphere` | sphere | domes, tree crowns, atoms |
| `cylinder` | axis along Y | columns, posts, tanks |
| `plane` | 1×1 in XY facing +Z; floors use rotation `[-1.571,0,0]` | ground, screens |
| `torus` | ring in XY facing +Z | rings, wheels |
| `cone` | apex up (+Y) | spires, tree crowns, traffic cones |
| `wedge` | right-triangle prism along Z, tall edge at −X sloping to +X | ramps, shed roofs, sloped canopies |
| `gable` | triangular prism, ridge along Z at the top | pitched roofs, dormers |
| `extrude` | `points` outline extruded along Y | L-, U-, T-shaped or angled footprints, podiums |

`extrude` needs `points`: 3 to 32 `[x,z]` corners within ±1 (normally ±0.5) with non-zero area. List them in order around the outline, either direction; crossing edges are not rejected but render incorrectly. `scale[0]` and `scale[2]` size the outline; `scale[1]` is its height.

### Optional rich fields

The format grew additively and keeps `schemaVersion: 1`: a document written before these fields validates to exactly the same output.

- **`repeat`** `{"count":[nx,ny,nz],"spacing":[dx,dy,dz]}` renders a grid of copies centered on the object's position, stepping along the object's own rotated axes (so a window grid stays on a rotated facade). Each count is an integer from 1 to 100; one object makes at most 400 copies and a scene at most 2,000 rendered copies. A count of `[1,1,1]` is dropped. Copies are ordinary meshes in one group named after the object (`Windows 1`, `Windows 2`, …), sharing one geometry and material, so the GLB and After Effects package see plain nodes, not GPU instancing.
- **`material.emissive`** `#RRGGBB` with **`emissiveIntensity`** from 0 to 10 (default 1) for lit windows, screens and lamps. It exports to glTF as `emissiveFactor` plus `KHR_materials_emissive_strength`.
- **`material.opacity`** from 0.05 to 1 for glass or water. Below 1 the material blends and does not write depth, and exports with `alphaMode: BLEND`.
- **Scene `camera`** `{"position":[x,y,z],"target":[x,y,z],"fov":deg}` is a model's estimate of the reference camera, in the shot's local coordinates (vertical field of view from 10 to 120). The geometry preview starts from it when it plausibly frames the objects. It is a reviewable suggestion: it is **never** written to the timeline's `camera` keys.
- **Scene `lights`**: up to 8 lights, each `{"type","name","color","intensity","position"}` plus type-specific fields, all in the shot's local coordinates:

  | `type` | Intensity | Extra fields (defaults) |
  | --- | --- | --- |
  | `directional` (sun, moon) | 0–10 | `target` (`[0,0,0]`) |
  | `point` (lamps, fixtures) | 0–500 candela, squared falloff | `distance` 0–1000 (0, no cutoff) |
  | `spot` (floodlights, downlights) | 0–500 candela, squared falloff | `target` (`[0,0,0]`), `distance` (0), `angle` 0.05–1.5 rad (0.6), `penumbra` 0–1 (0.3) |

  The units match Three.js and the original world (its point lights are 14–22 with a 35–50 range). Lights add to the editor's base lighting, shine only while their shot is shown, cast no shadows, and export to GLB as `KHR_lights_punctual`. The target must differ from the position. A light has no shape, so model a visible fixture as an emissive object. A shot with lights but no objects keeps the original world.

The editor's shape dropdown adds all nine primitives (an extrusion starts as an L footprint). The inspector's **Layer** picker moves an object between *Manual shapes* (no `layer`) and the four environment layers; Gemini 4 Argon assigns a layer to every object it returns. Fields without their own inputs (copies, footprint, glow, opacity) are listed read-only next to the shape, the shot label counts lights, and all of them stay intact through every edit and duplicate and are changed through Export/Import JSON. Z-fighting cleanup compares every field when it removes exact duplicates and never moves a repeated object or uses one as a host.

Earlier scenes without layers remain visible under **All layers** and **Manual shapes**. Explicit legacy `layer: "manual"`, `""` and `null` values normalize to an omitted layer; other unsupported layer names remain invalid. The layer filter lists editable primitives, while the seven original linked GLB models are managed separately in the model tools. A scene that cannot be loaded shows an error and retains the saved project for **Export timeline → Timeline JSON**, instead of silently replacing it with the starter timeline. The video renderer applies the same chapter placement and original-model replacement as the editor.

Shot-specific objects render **only during that shot**. When a draft shot has one or more primitive objects, the generic Phase 1 guide blockout hides automatically. The original hand-built models remain unchanged. Each shot can export its own binary GLB.

## Validation / safety for future AI

The validator rejects unsupported geometry, duplicate IDs, unrecognized shot IDs, nonfinite numbers, invalid materials, malformed footprints, repeats, cameras or lights, and oversized responses. Caps: up to 120 scenes, 200 objects per scene, 2000 total objects, 400 copies per repeated object, 2000 rendered copies and 8 lights per scene. The Cloudflare Worker imports this same validator (`primitive-schema.js`) for Gemini 4 Argon results; each Argon detail level asks for at most 120, 150 or 180 objects. It applies it part by part: an invalid object, light or camera is dropped and counted under a fixed repair code, and the rest of the paid scene is kept; the Flash profiles keep their own five-primitive validator and 24/36/48-object budgets. Names are bounded and inserted into HTML via `textContent`. Extra fields in generated content are ignored. No arbitrary JavaScript, URLs, remote textures, custom shaders or eval.

The Argon adapter repairs materials before rejecting an object: it expands three-digit hex colors, clamps numeric material fields and defaults missing or unsupported required values to neutral `#8899aa`, metalness `0.1` and roughness `0.7`. Valid supported material values stay intact. Geometry still must pass this shared validator. New direct-image jobs retain the original model text privately for 24 hours, including rejected output, for the authenticated editor's explicit download; downloading does not import it or run another generation.

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
