# Studio Create Wheel, Lights and Chapter Effects

## Create objects with the radial menu

Switch the 3D viewport from **View** to **Edit**. Right-click briefly on the
viewport to **repeat the last created item**. Hold right-click for **380 ms** to
open the radial Create wheel (or use **Shift+C**, or the visible **+ Create**
button). Hover over a first-ring category for **500 ms** to open its second
level. Click a first-ring category directly to repeat the most recent item
from that category. Click a second-level item to create it and remember it.

The wheel includes:
- **Lights:** warm/white/blue/red point, warm/cool spot, directional sun.
- **Primitives:** box, sphere, cylinder, cone, plane, torus, ramp, roof, extrusion.
- **Vegetation:** pine, leafy tree, shrub, grass.
- **Vehicles:** simple editable car, truck, delivery van, forklift blockouts.
- **Structures:** wall, column, door, glowing window.
- **Props:** crate, barrel, bollard, streetlamp.
- **Terrain:** ground, road, water, platform.

Presets are normal *editable low-poly primitives*, not downloaded branded or
photorealistic vehicle/tree meshes. Vehicles are composed of separately editable
pieces and do not yet expose a group-rig or physics. The first-ring / quick
right-click memory is local to your browser, not part of the project ZIP.

## Editable lights and materials

Within **3D Primitive Scene Editor**, use **Scene Lights** to select any of the
chapter's point, spot or directional lights. You can change the light name,
type, color, intensity and position, plus aiming target and range/beam fields
where relevant. New lights are fully validated and included in GLB exports
via KHR_lights_punctual. Each scene supports eight active punctual lights.

Select a primitive to adjust its geometry type, material color, metalness,
roughness, *emissive color/power* and opacity. The underlying shape remains an
ordinary bounded primitive. Some shape-specific footprint properties are still
edited in scene JSON. Lights are selected using the Inspector dropdown and
positioned numerically; they do not yet have in-viewport light-gizmo handles.

## Scene post-processing

Expand **SCENE EFFECTS · FOG / BLOOM / LOOK** in the project Inspector. Per
chapter controls include fog inheritance, fog off or custom color/density,
Unreal Bloom on/off plus strength/threshold/radius, exposure and vignette.
The settings persist in `primitiveScenes.scenes[].effects` and therefore in
Timeline JSON and portable ZIP. A chapter with effects alone (no primitives)
is valid and continues to render the default procedural world.

The live WebGL viewport and browser video renderer both use the same effect
settings; bloom creates a Three.js postprocessing composer on demand. It may
affect GPU cost. The GLB asset export preserves geometry, materials and
punctual lights, but fog, bloom and vignette are *screen-space compositing*;
external renderers and After Effects must implement equivalent effects
separately. Standalone timeline JSON carries the parameters.

Accepting fresh AI-generated geometry retains the existing chapter's
post-processing settings unless the incoming scene explicitly provides its
own look. No paid Gemini model call is made by Create or scene effects.
