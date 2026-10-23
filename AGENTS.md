# AI contributor instructions — Paige Video Render

For any video-to-3D work, **read [docs/VIDEO_TO_3D_AI_ROADMAP.md](docs/VIDEO_TO_3D_AI_ROADMAP.md) first**.

Mission: preserve the hand-authored *Atoms to AI* flythrough as the benchmark while building a reusable Video → Shot Timeline → 3D Primitives → Camera Flythrough → Video Export pipeline.

Implemented through Phase 2: offline video intake, visual chapter suggestions, editable storyboard review, draft timelines, and **manual, data-driven primitive geometry** with shot-specific editing and GLB export. AI inference of object identity, positions, lighting, and camera motion is **not implemented**. Read [docs/PRIMITIVE_SCENE_FORMAT.md](docs/PRIMITIVE_SCENE_FORMAT.md) before building the model adapter.

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

Read [docs/ARGON_BACKGROUND_IMAGE_INVESTIGATION.md](docs/ARGON_BACKGROUND_IMAGE_INVESTIGATION.md) (second pass) first. Interactions API errors are documented as `{error:{code,message}}` only: keep reducing them to the fixed-vocabulary `diagnostic` (phase, codes, reason, fields, terms). Never forward or log provider prose, and never drop the classification to a bare `unknown`. Background Argon jobs reject image input (provider restriction). The opt-in `argon_direct` profile therefore runs ONE synchronous inline-JPEG call (`store:false`) inside the `ArgonJob` Durable Object alarm (binding `ARGON_JOBS`, SQLite-backed for the Workers Free plan). Keep its "submitted before the paid call" marker and its never-throw alarm, so an at-least-once alarm can never bill twice. A Worker deploy restarts Durable Objects and cuts off a call in flight: the job stores the `CF_VERSION_METADATA` version with that marker and reports `job_interrupted_deploy` (else `job_interrupted`), which the editor attributes to Cloudflare, not Google; it is never resubmitted. PHP names each direct-image job before calling the Worker (`X-Argon-Job-Key`, job id `dk_<key>`, `idFromName`), so a start whose reply is lost is polled by that name; after 90 seconds a poll seals a missing job with a `start_not_received` tombstone that makes any late start a 409. Never retry the start itself. It has succeeded live (2026-10-22: 32 objects; 2026-10-23 on the rich format: 54 objects, 255 rendered parts, 26% of the token cap). It must never retry the paid call or fall back automatically; only free status polls may be retried. Both Argon profiles return the rich scene format (nine primitive types, `repeat` arrays, emissive glow, opacity, a required editor `layer` per object, up to 8 scene `lights`, a scene `camera` estimate; see docs/PRIMITIVE_SCENE_FORMAT.md), validated in the Worker by the shared `primitive-schema.js` (Wrangler bundles `../primitive-schema.js`). The editor's Argon thinking (`minimal`/`low`/`medium`/`high`) and detail (`standard`/`high`/`max`: caps 120/150/180, inside the fixed 32,768-token budget) settings are allowlisted in PHP and the Worker; missing values mean medium and standard. An answer cut off at the token limit keeps its complete objects (`closeTruncatedJson`, repair code `truncated`). Google accepted the larger response schema for `argon_direct` (2026-10-23), and the first full scene returned 69 objects, 354 rendered parts and 8 lights at 34% of the budget; Previs on the rich format is unverified until a live run. `full_scene` is the SAME single `argon_direct` call with a whole-environment prompt, never the four Flash passes; only PHP's `argon_start` for `argon_direct` and the Durable Object accept it, and Previs stays primary subject only. Scene lights shine only while their shot is shown, and lights without objects never replace the original world. Argon scenes are validated part by part (`validateArgonOutput`): drop and count invalid parts under the fixed `ARGON_REPAIR_CODES` (matched in PHP and the editor, tested) and keep the rest; fail only when no object survives (a well-formed answer with no objects at all fails with code `empty`, seen live at High and Maximum detail). Standard detail sends the exact prompt of the live 69-, 71- and 85-object scenes (High thinking works with it); keep it byte-identical unless a live run justifies a change. High and Maximum ask for the Standard scene first and then finer parts in the same answer, and rule out an empty objects array; the 12:57 EDT High-detail run still returned zero objects (see the post-#90 investigation below). Never discard a whole paid scene for one bad field, and never let model text choose a repair code. The direct call sends `X-Server-Timeout` (whole seconds, under the Worker's 12-minute abort and the 15-minute alarm limit), as Google's SDK does; without it a call past about 2 minutes failed with HTTP 5xx. Keep the rich fields optional in the Worker's response schema, with no length or range limits there (provider 400 risk); bounds belong in the validator. The scene camera only frames the preview and must never be written to timeline camera keys. Argon token usage is reduced to fixed numeric keys (`USAGE_KEYS` in the Worker, matched in PHP and tested); keep it numbers only and never copy Google's usage object or other response metadata. Flash profiles keep their own five-primitive validator, prompts and 24/36/48-object budgets. Flash-Lite → Argon Previs stays the proven path.

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
