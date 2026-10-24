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

- Browser-local sources must be relinked after reload; ZIP/portable media
  bundling is not implemented.
- Still scenes can set their duration, but generating one does not create motion
  automatically; resulting Three.js 3D geometry remains editable.
- Mixed-media playback is a browser storyboard preview, not a pre-rendered
  concatenated MP4.
- Timeline zoom, resizing and precise shot navigation are implemented, but
  advanced multitrack ripple edits, full undo/redo and animation curves are
  not yet part of this change set.
- The original 3D camera track, text track and export formats remain intact.
