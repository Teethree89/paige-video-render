# AI contributor instructions — Paige Video Render

For any video-to-3D work, **read [docs/VIDEO_TO_3D_AI_ROADMAP.md](docs/VIDEO_TO_3D_AI_ROADMAP.md) first**.

Mission: preserve the hand-authored *Atoms to AI* flythrough as the benchmark while building a reusable Video → Shot Timeline → 3D Primitives → Camera Flythrough → Video Export pipeline.

Current implementation includes offline video intake, chapter suggestions, primitive editing, AI geometry proposals and reviewable video camera estimates. Camera estimation is not calibrated metric reconstruction. Read [docs/VIDEO_CAMERA_MOTION.md](docs/VIDEO_CAMERA_MOTION.md) and [docs/PRIMITIVE_SCENE_FORMAT.md](docs/PRIMITIVE_SCENE_FORMAT.md) before changing these adapters.

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

## Video camera motion estimates

Fresh video drafts use stationary placeholder cameras. Imported-video generation
can first run a separately confirmed camera analysis: eleven bounded chronological
JPEGs in one Gemini 3.8 Flash Low or 3.5 Flash-Lite Minimal call. Reuse validated
`shots[].videoCameraMotion` only while chapter start/end still match. Never retry
or switch models automatically. The existing session/CSRF and Worker token remain
required. Camera analysis has its own bounded 20/hour session counter; it does
not spend the geometry request allowance or bypass Google's project quotas.
Pass only validated numeric motion data and fixed type labels to geometry;
never promote the model's uncertainty prose into geometry instructions.
Fit the estimated trajectory to actual geometry, freeze sceneAnchor, and require
preview/Accept or Apply before saving camera keys. Only placeholder keys may
auto-stage video motion; authored keys need explicit selection. The optional
scene camera is a framing/orientation reference, never copied verbatim to the
timeline. No live provider call, merge or deployment is implied by offline tests.

## Phase 3 Zen proof-of-concept

Read [docs/ZEN_AI_SCENE_PROTOTYPE.md](docs/ZEN_AI_SCENE_PROTOTYPE.md). A GitHub Actions **runner-only** script sends 3 frames from the public example MP4 to the free Muse Contributor model via the documented Responses endpoint. It produces a strictly validated, importable JSON artifact. The **website is NOT connected to the provider**; never expose `zen_api` in JavaScript. Model endpoint multimodal compatibility is unverified until the first live Actions run. No automatic overwrite of the original scene.

The first raw HTTP Zen Responses test got HTTP 403 with the configured secret. For free models the workflow now uses the official `@opencode/cli` client (no fake headers, no paid fallback). Confirm real CLI success from Actions before advertising working AI geometry.

**Verified blocker 2026-10-14:** model calls to Muse Contributor Free returned `FREE_TIER_CLIENT_RESTRICTION` even from an Actions runner with official OpenCode CLI. Do not claim this integration is working; inspect docs/ZEN_AI_SCENE_PROTOTYPE.md before proceeding. Never spoof OpenCode client headers or silently choose a paid model.

## Multi-model Zen experiment

The experimental workflow `.github/workflows/zen-free-model-benchmark.yml` tests MiMo-V2.6 Flash Free, MiMo-V2.5 Free, Nemotron 3.5 Lightning Free and Big Pickle. It distinguishes text-only API acceptance from true image-to-geometry success. Only the already-public reference `hall` clip may be sent, using `zen_api` inside GitHub Actions. Read sanitized model artifacts before making any integration claim. The original Muse Contributor free model returned a 403 free-tier restriction; do not pretend the limitation is resolved until evidenced.

## Private PHP → Worker backend

See [docs/PHP_AI_SCENE_SETUP.md](docs/PHP_AI_SCENE_SETUP.md). The actual server file `/www/certificates/paiver.php` is manually created OUTSIDE the public FTP directory; do not put its values anywhere in the repository or ZIP. The public `scene-proxy.php` is protected by editor passphrase, PHP session, CSRF, strict workers.dev target and bounded JPEG requests. The Worker uses `GEMINI_API_KEY` and `SCENE_ACCESS_TOKEN` runtime secrets for Gemini 2.5 Flash-Lite. Never create an open browser-to-Worker auth path. Do not claim live functionality until hosting PHP/cURL and deployed Cloudflare Worker are independently confirmed.

**Production PHP is 7.0.33** (live `X-Powered-By` header). `scene-proxy.php` must use PHP 7.0 syntax only: no nullable types (`?array`, `?callable`), no return types on closures, and `void` only on functions that always `exit`. A 7.1+ construct is a parse error in production that turns every request into an empty HTTP 500. CI lints with `php:7.0-cli`.

## Argon direct image and provider diagnostics

Read [docs/ARGON_BACKGROUND_IMAGE_INVESTIGATION.md](docs/ARGON_BACKGROUND_IMAGE_INVESTIGATION.md) (second pass) first. Interactions API errors are documented as `{error:{code,message}}` only: keep reducing them to the fixed-vocabulary `diagnostic` (phase, codes, reason, fields, terms). Never forward or log provider prose, and never drop the classification to a bare `unknown`. Background Argon jobs reject image input (provider restriction). The opt-in `argon_direct` profile therefore runs ONE synchronous inline-JPEG call (`store:false`) inside the `ArgonJob` Durable Object alarm (binding `ARGON_JOBS`, SQLite-backed for the Workers Free plan). Keep its "submitted before the paid call" marker and its never-throw alarm, so an at-least-once alarm can never bill twice. A Worker deploy restarts Durable Objects and cuts off a call in flight: the job stores the `CF_VERSION_METADATA` version with that marker and reports `job_interrupted_deploy` (else `job_interrupted`), which the editor attributes to Cloudflare, not Google; it is never resubmitted. PHP names each direct-image job before calling the Worker (`X-Argon-Job-Key`, job id `dk_<key>`, `idFromName`), so a start whose reply is lost is polled by that name; after 90 seconds a poll seals a missing job with a `start_not_received` tombstone that makes any late start a 409. Never retry the start itself. It has succeeded live (2026-10-22: 32 objects; 2026-10-23 on the rich format: 54 objects, 255 rendered parts, 26% of the token cap). Each job must never retry the paid call or fall back automatically; the explicit browser consent exception for up to three new jobs is specified below. Both Argon profiles return the rich scene format (nine primitive types, `repeat` arrays, emissive glow, opacity, a required editor `layer` per object, up to 8 scene `lights`, a scene `camera` estimate; see docs/PRIMITIVE_SCENE_FORMAT.md), validated in the Worker by the shared `primitive-schema.js` (Wrangler bundles `../primitive-schema.js`). The editor's Argon thinking (`minimal`/`low`/`medium`/`high`) and detail (`standard`/`high`/`max`: caps 120/150/240, inside the fixed 32,768-token budget) settings are allowlisted in PHP and the Worker; missing values mean medium and standard. An answer cut off at the token limit keeps its complete objects (`closeTruncatedJson`, repair code `truncated`). Google accepted the larger response schema for `argon_direct` (2026-10-23), and the first full scene returned 69 objects, 354 rendered parts and 8 lights at 34% of the budget; Previs on the rich format is unverified until a live run. `full_scene` is the SAME single `argon_direct` call with a whole-environment prompt, never the four Flash passes; only PHP's `argon_start` for `argon_direct` and the Durable Object accept it, and Previs stays primary subject only. Scene lights shine only while their shot is shown, and lights without objects never replace the original world. Argon scenes are validated part by part (`validateArgonOutput`): drop and count invalid parts under the fixed `ARGON_REPAIR_CODES` (matched in PHP and the editor, tested) and keep the rest; fail only when no object survives (a well-formed answer with no objects at all fails with code `empty`, seen live at High and Maximum detail). Standard detail sends the exact prompt of the live 69-, 71- and 85-object scenes (High thinking works with it); keep it byte-identical unless a live run justifies a change. High and Maximum ask for the Standard scene first and then finer parts in the same answer, and rule out an empty objects array; the 12:57 EDT High-detail run still returned zero objects (see the post-#90 investigation below). Never discard a whole paid scene for one bad field, and never let model text choose a repair code. The direct call sends `X-Server-Timeout` (whole seconds, under the Worker's 12-minute abort and the 15-minute alarm limit), as Google's SDK does; without it a call past about 2 minutes failed with HTTP 5xx. Keep the rich fields optional in the Worker's response schema, with no length or range limits there (provider 400 risk); bounds belong in the validator. The scene camera only frames the preview and must never be written to timeline camera keys. Argon token usage is reduced to fixed numeric keys (`USAGE_KEYS` in the Worker, matched in PHP and tested); keep it numbers only and never copy Google's usage object or other response metadata. Flash profiles keep their own five-primitive validator, prompts and 24/36/48-object budgets. Flash-Lite → Argon Previs stays the proven path.

## Argon detail investigation after PR #90

Read the **Post-#90 detail collapse investigation (2026-10-23, 12:57 EDT)**
section of [docs/ARGON_BACKGROUND_IMAGE_INVESTIGATION.md](docs/ARGON_BACKGROUND_IMAGE_INVESTIGATION.md).
The two-stage High prompt also returned zero objects. The exact trigger is
unverified; do not present a 90-object provider ceiling, parent-field conflict,
or the removed budget warning as established causes. Standard already contains
parent-surface instructions. Keep Standard byte-identical and the default 32,768-token
budget/schema unchanged (High and Maximum select the 65,536-token budget below,
the only budget exception); tests pin both complete Standard direct-image prompts.
`node scripts/inspect_argon_prompts.mjs` captures the request offline with dummy
credentials, synthetic frames and a stubbed fetch. Its experiment variants are
text for review, not editor settings or live requests. No paid call or retry is
authorized by running this script. Every live experiment requires the user's
separate explicit editor confirmation. Never merge or deploy without review;
even a documentation merge can trigger deployment and interrupt a paid job.
The recommended future add-detail pass must preserve the base scene, validate
only new candidates against remaining object/copy capacity, and revalidate the
combined document before an explicit Apply. Do not feed the combined scene to
the existing largest-repeat-dropping repair loop, which could delete base parts.

## Editor help text

Single-video imports cache one original File in local IndexedDB, matched only by
`videoIntake.sourceId`. Reference Builder images/clips are cached the same way,
keyed by `mediaId` (`local-media-store.js`). Every cached file expires a fixed
48 hours after it was saved (reading never extends it; re-adding/relinking
restarts it); expired entries are deleted on read, at startup and every 30
minutes, and the UI must say so. Never upload them for persistence. Restore a fresh blob URL after reload; never attach an
unrelated cached video or upload the original for persistence. Storage failure
must leave the active source usable with a reattach notice. Clear workspace
awaits pending cache writes and removes the cached source, preserving libraries.
Keep missing-source status truthful: no bundled poster or enabled overlay until
the original is available. AI diagnostics stay in the bottom closed accordion;
live generation status and elapsed time remain outside it.

Static explainer paragraphs (`p.field-help` without an `id` or `role`) are folded behind "?" buttons by `help-toggles.js`; live status lines must keep an `id` or `role` so they stay visible. Without the script every explanation stays open. Paid requests (Argon starts and paid diagnostics) confirm in the page's `#aiConfirm` dialog, never `window.confirm()`: Chrome silently dismisses that in a background tab, which reads as Cancel. Only an explicit OK starts a paid call; Cancel, Escape or a dismissed dialog logs that nothing was sent. Orbit zoom-out has no distance limit; the clip planes follow the orbit distance and reset to the cinematic camera's fixed planes in `applyCamera`.


## Argon stream and connection recovery

`argon-stream-recovery-v1` consumes the same one paid direct-image request as SSE (`stream:true`, `store:false`, no background), according to Google's Interactions OpenAPI `StepStart`/`StepDelta`/`StepStop`/`InteractionCompletedEvent`. Terminal events may contain only status; preserve model-output deltas and cumulative numeric usage from step events. Never retain or log thought steps, input echoes, IDs or continuation tokens, and never resubmit after an SSE error or disconnect. Require terminal completion (or token-limit incomplete) before scene validation. Node fragmentation/error tests and the workerd mock exercise the streamed body. Browser status polls have a 40-second deadline and retry network/408/429/5xx failures with backoff up to 30 seconds within the 16-minute view window, including more than three HTTP failures. Auth/input errors and terminal jobs stop immediately. Only free status checks retry. Connection refusals do not establish the hosting root cause. The PHP diagnostic validator accepts only integer HTTP error statuses 400–599 (or null); preserve exact statuses, including 502 `provider_gateway`, rather than obscuring them as provider availability. A dropped stream does not establish whether Google billed the call.


## Preserve original Argon output and repair materials

`argon-output-material-v1` saves bounded `model_output` text in a separate private Durable Object key BEFORE scene validation. The existing 24-hour job cleanup removes it; only an explicit session+CSRF `argon_output` request may download it. Normal status replies, health, provider diagnostics and logs must never contain that text. Do not retain thought steps, input echoes, provider prose or continuation IDs. Stream errors may retain only the collected model-output prefix, marked partial. The authenticated Worker output route binds job/shot exactly like status; PHP accepts no caller-supplied job IDs and returns only bounded output text, shot ID and the partial flag. Previs downloads are a free GET of its existing stored interaction. Never retry generation for a download. Older completed/failed direct-image jobs cannot be recovered because the previous Worker did not retain original output.

Only the Argon adapter repairs invalid materials: preserve valid supported values, expand three-digit hex, clamp numeric values and use neutral #8899aa / metalness 0.1 / roughness 0.7 when required fields are missing or unsupported. Remove invalid optional emission or default invalid opacity. Count this under the fixed `material` repair code. Geometry, transforms, primitive types and the shared validator stay strict; never run model material/shader code. Original downloads stay byte-for-byte model text, even when invalid JSON; do not automatically import or execute them. The editor provides the latest job's output, so download before starting another job.

## Saved timeline compatibility

Unlayered v1 objects and legacy `layer: "manual"`, empty or null values belong to Manual shapes and must appear under All layers; canonical output omits their layer. Unknown nonempty layers still fail validation. A saved geometry validation/build error must never replace the working project with the original timeline or overwrite its cached source. Clear partial render meshes, report the error and retain the original project for Timeline JSON export/repair. The inspector must remain usable enough to show this error without crashing startup. Video rendering uses the same chapter anchors and primitive-overrides-original visibility as the editor; layerless scenes keep their original transforms/materials.

## Explicit 65,536-token experiment (`argon-65k-budget-v1`)

The user asked for a larger token budget on 2026-10-23 to test Argon's own
explanation for the empty High/Maximum scenes. A 100,000-token version needed
`background:true,store:true` (Google requires a stored background job above
65,536) and was rejected live at create: HTTP 400 `invalid_request`
(14:22 EDT), the same background-plus-image restriction this investigation
started with. It was replaced by Google's largest synchronous allowance. The
Direct image token-budget selector accepts exactly 32,768 (default) or 65,536;
PHP and the Worker both enforce it, and Previs cannot use it. The 65,536 run
is the SAME streamed `store:false` call with inline images: only
`max_output_tokens` changes, and usage reports that cap. Never reintroduce a
background path for image input. Live result (2026-10-23, exterior, full
scene): every High or Maximum run at 32,768 came back empty, while at 65,536
Medium/High returned 117 objects, Medium/Maximum 106 and High/Maximum 153
(42% of the budget at most); one earlier High/Maximum attempt at 65,536 failed
without a recorded log. Choosing High or Maximum detail therefore selects
65,536 in the editor, and Standard selects 32,768 (Standard's request stays
byte-identical); the user can still change it. The budget is a ceiling: only
generated tokens are billed. The existing raw-output size guard, 12-minute
call deadline and geometry limits remain in force.
Read the investigation/setup sections for the single-run procedure. No paid
provider run, merge or production deploy is implied by offline validation.


## Larger Maximum scenes and three guarded automatic retries (2026-10-23)

Maximum full scenes target 180–230 objects (prompt cap 240). The shared
validator permits 240 objects per scene; 2,000 total objects and 2,000 rendered
copies per scene remain enforced. High and Standard prompts/targets, including
both byte-pinned Standard prompts, are unchanged. Raw model output is limited
to 280,000 characters; PHP original-output downloads to 1,120,000 UTF-8
bytes. Provider response schema has no new bounds.

Direct image has a checked-on-by-default automatic retry option, explicitly
disclosed in the paid confirmation. A single confirmation authorizes at most
**three retries after the initial request (four potentially billable attempts)**
with **15 seconds between eligible attempts**. Each new attempt sends the
identical payload but creates a separately named paid job. After EACH attempt,
the browser may retry only following terminal `scene_schema_mismatch` when
both thinking and output are known nonnegative integers whose sum is
**strictly below 10,000**; or following a sealed `start_not_received` job
that conclusively never reached Google. Every retry requires its own preceding
eligible failure. Input tokens are excluded from the 10k threshold but are
billed again on every submitted attempt; each also consumes a request slot.
At exactly 10,000 or with incomplete/unknown usage, stop. Provider errors,
partial streams, uncertain starts, network failures and deploy interruptions
never trigger a paid retry, regardless of tokens observed.

The browser controls the retry chain while its generation view stays active;
closing or refreshing the editor does not schedule further paid retries.
Existing started jobs may still be resumed/polled for free. Each Durable
Object alarm must continue to submit **at most once**; alarm replay, status
polls and resume never create another paid job. The latest-job original-output
download points to the latest attempt. Turning off retries means one attempt.

Synchronous budgets remain 32,768/65,536 with `stream:true`, `store:false`
and no background-image mode. High/Maximum select 65,536 by default, Standard
32,768; manual selection remains available. The 180–230-object target and
multi-retry recovery have not been verified live. No provider calls or
production deployment are part of offline validation; merging can interrupt
an active paid job.

## Additive Argon tails and PAIGE progress loader (PR #94)

For `argon_direct` full-scene jobs, the **Add two detail passes automatically**
checkbox is enabled by default and can be unchecked independently from the
three guarded base retries. The single paid confirmation includes these two
additional, potentially billable *separate* calls (up to four base attempts
if every cheap failure qualifies, plus two detail calls). Each detail call
uses the same three inline JPEGs and sends a bounded existing-object index.
Worker `validateDetailContext` accepts only passes 1 and 2, full-scene
mode, at most 239 existing entries, strictly checked object IDs, primitive
types, layers, positions and scales; never accept arbitrary prompt text.
`argonAddDetailPrompt` asks for **only new visible details**, not a new scene;
the original Standard and Maximum base prompts are unchanged.
The browser `appendArgonDetail` function appends valid distinct objects,
preserving the existing objects, camera and scene lights, enforcing 240 total
editable objects and 2,000 rendered copies. If a detail pass fails or its
start is uncertain, stop submitting subsequent paid calls and preview the
successful partial scene. Repeated alarms/status polling never submit a new
paid job, and reloading does not schedule detail passes or retries.

The full-viewport PAIGE particle cloud is decorative and pointer-responsive.
The moving track is **indeterminate**, not a percentage or ETA. Argon SSE
`step.start` events may advance a private Durable Object stage to
`reasoning` or `geometry`; after the provider response it advances to
`validating`. These fixed stage labels plus elapsed seconds are the only
new status data exposed to authenticated PHP/browser polls. Do not expose
thought text, partial provider output, image bytes or provider metadata.
Provider does not promise an ETA, and some models may emit no intermediate
steps at all. The overlay may be minimized without cancelling a paid job.
Do not merge during running paid Argon calls. No live paid model runs were
performed by this change.

## Independent View/Edit primitive interaction (PR #95)

The transport View/Edit selector is **not** part of paid Argon generation.
View preserves normal cinematic playback. Edit pauses playback, uses the
existing OrbitControls camera (temporary only), raycasts accepted shot-local
primitive meshes, selects an entire repeated-group object by its
`primitiveId`, and highlights it without changing the object's material.
Three.js TransformControls uses the pinned 0.166.1 build: its controls object
is added to the scene (newer Three releases use `getHelper()`).

Entering Edit keeps the current view camera (the timeline camera at the playhead,
or the user's orbit pose) so camera keys and the source overlay stay lined up;
only the AI geometry preview may reframe the camera
(`tests/browser/edit-mode-camera.mjs`). W (or G) selects XYZ move; E (or R) selects local XYZ rotate. Gizmo drags
update the *view* first and commit through `editPrimitiveTransform` on mouse
release, including strict schema validation. Delete removes only the selected
object via `deletePrimitiveObject`. The primitive inspector dropdown and
numeric XYZ fields remain synchronized with viewport selection. Scene edits
autosave to the existing local timeline document and export in JSON/GLB/AE
without changing camera keyframes, other chapters, repeats or scene lights.
Edit mode cannot mutate a pending AI proposal: accept/discard it first. Playing,
changing chapters or importing/resetting the timeline closes Edit safely.
External prebuilt GLB assets are not individually editable in this mode.
Do not save the temporary BoxHelper, TransformControls, review grid or orbit
camera into project data. Use `tests/test_scene_object_edit.mjs` and the pinned
Three.js integration test to guard the interaction.


## Pinned-point camera tracking wizard and guided chapters

There is no automatic whole-chapter camera tracking. Motion tab → **Track camera…**
opens a per-chapter wizard (`camera-track-wizard.js`): pin corners in the video
(snapped by `snapToCorner`), pin the same spots on the 3D model, review a
before/after wipe, track, preview, Apply. `camera-resection.js` (PnP) gives the
camera at the reference frame, `camera-anchor.js` places the locally tracked
relative path (`camera-track-solver.js`, seeded/deterministic, local) into the
model and `buildAnchoredCameraProposal` replaces ONLY that chapter's keys
(`generated:'video-track'`, frozen `sceneAnchor`, via the existing preview/Apply
path). It is still a reviewable estimate (relative lens/scale, roll not stored):
keep preview/Apply and the refusal rules; do not loosen scenario limits to pass
a change. Run `node scripts/camera_track_harness.mjs`, the node tests listed in
validate.yml and `tests/browser/camera-track-wizard.mjs`. The browser tracker
(`feature-tracker.js`, `camera-track-pipeline.js`, `camera-track-worker.js`,
`camera-track-ui.js`) reads only the local source in this browser; never upload
frames, pins or tracks. Keep the seek guard. `chapter-workflow.js` derives chapter
progress from timeline data only; keep `nameConfirmed`/`cameraConfirmed` optional
so older timelines load.

## Viewport tools

`viewport-tools.js` drives the strip at the bottom-left of the viewport: **Orbit** (O), **Move** (W), **Rotate** (E) and **Point** (P). Only one is active, so navigating never moves or marks anything by accident. Orbit hides and disables the transform gizmo; Move/Rotate need Edit mode; Point exists only while the camera tracker is open and gates both model picking and video-frame point placement/dragging (the wizard asks `host.getTool()`). While the tracker is open Move/Rotate are unavailable.
