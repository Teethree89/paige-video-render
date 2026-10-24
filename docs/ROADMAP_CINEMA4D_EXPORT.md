# Cinema 4D export roadmap (deferred)

**Status:** Backlog / discovery only. **Do not implement as a dependency** of the Paige Studio → After Effects export. The short-term deliverable is stable editing, lighting, camera sync and AE-native effect reconstruction.

## Product goal

A `Export → Cinema 4D Scene Package` produces editable 3D geometry, materials, lights, camera tracks and shot structure in Cinema 4D, independent of After Effects. A native `.c4d` file is an **output produced locally by a Cinema 4D Python scene-builder**, not a format the web editor pretends it can serialize directly. The package can include GLBs, a bounded scene JSON, a Python bootstrap script and import documentation.

### Stage C4D-0 — compatibility spike

- Verify installed C4D version, edition (Lite versus full), and target renderer (Standard, Physical or Redshift).
- Validate importing one Paige GLB with emissive PBR materials, transparent components, shape repetitions, and a punctual light reconstructed from metadata.
- Confirm coordinate conventions (Three.js Y-up, handedness, unit scaling), animation frame rates, lens/FOV and AE registration with real test frames.
- Avoid routing the primary C4D export through an After Effects composition; AE's Maxon Cinema 4D exporter is not a lossless transfer of imported GLB model layers.

### Stage C4D-1 — deterministic shot scene

- Package **accepted** chapter geometry as scene-local GLB assets plus a versioned shot manifest. Include the stable `sceneAnchor` and effective scene-to-export origin.
- Recreate each light as an editable native C4D light with type, name, position, direction, color, intensity, cone/softness and range. glTF's `KHR_lights_punctual` cannot be assumed to survive every C4D importer.
- Rebuild each native camera and bake the evaluated (smooth, linear, hold, eased or custom Bézier) Three.js camera trajectory at the source FPS. Preserve cut boundaries explicitly and validate no movement of the accepted model.
- Use a per-shot hierarchy, naming and deterministic IDs so exports can be repeated and diffed.

### Stage C4D-2 — looks and shot effects

- Map PBR base color, metalness/roughness, opacity and emissive materials to native C4D materials. Exact appearance requires a renderer-aware look-development pass.
- Rebuild custom/default/off fog, bloom/glow, exposure and vignette using native volumetrics or render-engine post effects. Record approximate substitutions and unsupported features; do not claim bit-identical output to Three.js UnrealBloomPass.
- Export a companion JSON of unsupported/approximated parameters for audit.

### Stage C4D-3 — UX and validation

- Offer **Scene Package ZIP** first, with a Cinema 4D Python bootstrap that validates asset paths, version and field bounds before building the editable project.
- Add 3D coordinate/scale calibration scenes and compare fixed camera frames against Paige's WebGL render, including clipping and chapter cuts.
- Validate C4D Lite restrictions, embedded textures, light count, unsupported imported assets, version compatibility and round-trip project open.
- Only after the above, consider an optional direct `.c4d` handoff through a desktop bridge or Cinema 4D command-line runtime; a browser alone cannot author its binary format reliably.

## Dependencies and non-goals

- The current AE builder and native AE lighting/effects work remain independent. They are not blocked on a C4D renderer, plugin, network service or paid AI.
- No automatic conversion from AE `.aep` to a full-fidelity Cinema 4D geometry scene is promised.
- No C4D Python script or binary `.c4d` file is shipped in this roadmap PR.
- Original, unaccepted or reference-media-only footage is not reconstructed as native geometry.

## Acceptance criteria for future activation

One 10-second mixed chapter package can be opened in the target Cinema 4D edition with geometry, editable camera keyframes, three native light types, material/emissive settings, and a documented fog/bloom approximation; coordinates match source units within an agreed tolerance and resulting scenes can be saved as unique `.c4d` files without overwriting the user's work.
