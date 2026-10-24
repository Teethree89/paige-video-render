# Paige Studio — Workspace & Reference Builder

The workspace overhaul is implemented as four stacked, reviewable pull requests:

1. Workspace and timeline tools (PR #99): resizable 3D viewport/timeline split,
   adjustable inspector width, 1×–12× horizontal timeline zoom, fit to sequence,
   and Objects/AI shortcuts. Layout is stored in browser localStorage only.
2. Mixed-media Reference Builder (PR #100): local MP4/MOV/WebM and PNG/JPEG/WebP
   imports; scene reorder, duplicate, delete, still duration, video in/out,
   framing (contain/cover), and sequence-to-3D timeline conversion.
3. Per-reference AI sampling (PR #101): the existing browser → PHP → Cloudflare
   Worker generation path receives three JPEG frames sourced from an attached
   image or a trimmed clip. Paid Argon confirmations and retry guards are
   unchanged. A missing original file disables generation before paid consent.
4. Sequence playback (PR #102): drag reorder, Play/Pause through the complete
   local image/video sequence, and non-destructive split at the source video
   preview playhead.

## Working with sources

Open **Reference Builder** in the top toolbar; **Add media** to import one or
more files. They remain on your device and are referenced using object URLs.
Reorder scene cards (drag and drop or ↑/↓), trim video in/out, set still duration,
and use **Use in 3D Editor** to create a timeline containing the new references.

**Export reference JSON** or **Export timeline JSON** includes scene order, stable
scene IDs, source filenames, source media IDs, trimmed ranges, duration and
framing. No original video, image pixels, data URLs or local filesystem paths
are exported. After reloading or importing JSON, open Reference Builder and use
**Relink files** with the original media; matching uses filename, type and size.
Original media are never persisted to localStorage.

The original one-video cut analyzer, built-in reference video, and existing
scene JSON are still supported. Applying a newly composed reference intentionally
*replaces the working timeline*, after a confirmation. Export existing timeline
JSON before doing this. Existing scene geometry is never silently remapped from
a different chapter.

## Generation and cost

When an attached reference scene is selected, generating 3D geometry samples
three frames from its source media and continues through the existing
authenticated gateway. For a still image, the same local image is encoded
into three bounded JPEG frames to comply with the established three-frame
contract. For videos, the current reference playhead and two contextual times
are mapped to the clip's trimmed original in/out range. Frame data is sized
and compressed in the browser before submission.

The UI blocks missing local media before any potentially billable AI call.
It does **not** reduce the existing confirmation prompts, token budgets,
rate-limit restrictions, Argon retry eligibility or Durable Object idempotency
rules. Use an inexpensive model first to validate output quality after deploying.
Merge or deploy only while no paid Argon job is active.

## Explicit scope limitations

- Browser-local sources still require relinking after ordinary JSON import/reload;
  **Export with media ZIP** and **Open project ZIP** are now available for projects
  with up to 256 MiB of source media.
- Still scenes can set their duration, but generating one does not create motion
  automatically; resulting Three.js 3D geometry remains editable.
- Mixed-media playback is a browser storyboard preview, not a pre-rendered
  concatenated MP4.
- Timeline shot duplication/copy/paste, camera/text key dragging, ripple trimming,
  chapter reorder/delete, track locks, and undo/redo now follow in PR #104.
  Advanced camera easing, Bézier handles and multi-channel graphs follow in #105.
  These work across the existing scene/camera/text tracks; audio editing and
  transition effects are outside this project scope.
- The original 3D camera track, text track and export formats remain intact.

## Complete timeline editing (PR #104)

Use the bar above the timeline to select **Copy** and **Paste** for the active
chapter, including its accepted scene geometry, contained camera keys, text and
reference media ID. Pasted scenes have new shot/object/key IDs, not aliases.
Drag the right edge of a chapter to resize; **Ripple ON** shifts later scenes
and keys, while **Ripple OFF** moves the shared boundary and retimes the
adjacent scene. You can type an exact chapter duration in the Inspector.
Drag camera diamonds and text bars to retime them; resize text with its
right-edge handle. Camera key time is also editable numerically. Use track
locks to prevent accidental edits and **Snap ON** to snap to frame/boundary
positions. Undo/Redo work with Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Y).

Moving/deleting a chapter that has a caption spanning multiple chapter
boundaries is intentionally refused: split the caption first rather than
silently moving or truncating it. Structural timeline edits are disabled
while a paid Argon job is active or an unsaved geometry proposal is pending.

## Camera curves (PR #105)

Select a camera key in the timeline to use the Inspector's **Animation Curves**
panel. Choose legacy smooth, linear, ease-in, ease-out, hold/step or custom
Bézier. Drag either cubic handle or type normalized coordinates. The value
graph plots X/Y/Z camera position and field of view over the whole timeline.
Select a text overlay to choose a fade interpolation profile. Existing timelines
without per-key curve metadata retain the original smooth camera path.

## Portable full-project ZIP (PR #106)

Reference Builder's **Export with media ZIP** writes a portable archive with
the editable timeline and all attached source images/videos, deduplicated by
media ID. **Open project ZIP** reimports both the document and its local source
files, after explicitly asking before replacing the current timeline. Existing
JSON export and After Effects export are unchanged.

This is an uncompressed stored ZIP. To avoid browser memory exhaustion, export
and import are capped at 256 MiB of original media and 80 unique media assets.
For larger productions, use JSON plus original files, or split the project.
No source media or API key is uploaded to any server during ZIP creation.
