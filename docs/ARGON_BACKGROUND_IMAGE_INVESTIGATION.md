# Argon background image rejection — 2026-10-22

## Second pass: why the HTTP 400 is still unexplained

Baseline: `2ba232d` (`main`, PR #73). No paid or live provider request was
made for this pass. It relies on static analysis, Google's published
documentation and OpenAPI spec, public provider reports, and offline tests.

### Root cause

**What we can verify is a local defect: the Worker discarded the only reason
Google gives.** The Interactions API documents its 4XX body as
`{"error": {"code", "message"}}`. `code` is "a URI that identifies the error
type" and `message` is "a human-readable error message" (OpenAPI `Error`
schema, `CreateInteraction` responses `4XX`/`5XX`). Bodies reported publicly in
September and October 2026 look like
`{"error":{"message":"Model 'gemini-3.8-flash' does not support background interactions.","code":"invalid_request"}}`.
They have no `details`, `fieldViolations` or field paths.

`argonErrorCategory()` looked only for `google.rpc.BadRequest.fieldViolations`
and a few field-path regexes. It never read `error.code` and threw the message
away. So every real Interactions 400 became `unknown`. The test suite even
pinned `"The model cannot process this image in a background request"` to
`unknown`. Because of this, the seven paid diagnostic stages could never have
reported why stages 6 and 7 were rejected.

**We found no request-contract mismatch.** Failing request C is exactly
request A (synchronous image, passed) plus the two fields that request B
(background text, passed) adds. Request D is C with the documented `uri` in
place of `data`. Every field appears in the published
`CreateModelInteractionParams` and `ImageContent` schemas. No Google page
restricts `background` by input type. The 2026-05-20 `Api-Revision` cannot
separate these requests either: all of them sent it, and Google says the header
has been ignored since the legacy schema was removed on June 8.

So the provider-side cause is **unverified, not unsupported**. Google
documents images and background execution for `gemini-4-argon`, and does not
document the combination as forbidden.

Two smaller defects made the evidence harder to read:

- A 400 on the **status GET** used the same Worker error as a create 400, and
  PHP told the user "No job was created". The job could already exist.
- A rejected status GET left the PHP diagnostic stage `running`. That blocks
  both retry and reset for the rest of the session.

### Was the 400 from the create POST or the poll GET?

By inference, the create POST. A failed GET would have left the stage
`running`, and no further action would be possible. Stage 6 was later
retried with the Files transport, and a retry requires the `failed` state.
PHP sets that state only just before the create POST. This is not proof: a
lost PHP session would also reset the state. The new diagnostics record the
`phase` explicitly.

### Sanitized request reconstruction

All four requests are `POST https://generativelanguage.googleapis.com/v1beta/interactions`
with `Content-Type: application/json`, `x-goog-api-key: [redacted]` and
`Api-Revision: 2026-05-20`. The image is the verified 686-byte, 32×32 synthetic
JPEG (sha256 `f43da1db…`), never client footage.

| | `input` | `generation_config` | `background`/`store` | Result |
| --- | --- | --- | --- | --- |
| **A** stage 3 | `[{type:text}, {type:image, data, mime_type:image/jpeg}]` | `low`, 4,096 | absent | Pass |
| **B** stage 5 | `"Reply with OK."` (string) | `low`, 4,096 | `true`/`true` | Pass |
| **C** stage 6 @`72973e3` | identical to A | identical | `true`/`true` | HTTP 400 |
| **D** stage 6 @`b3f687f` | A with `uri: https://generativelanguage.googleapis.com/v1beta/files/<id>` instead of `data` | identical | `true`/`true` | HTTP 400 |

Structural differences: A→C adds only `background` and `store`. B→C changes
only `input`, from the string variant to the ContentList variant of the
documented `InteractionsInput` oneOf. C→D swaps `data` for `uri` and adds a
Files upload. None of the failing requests used `response_format`, so the
scene schema is not involved. Neither did the passing ones, apart from stage 4.

### Documented contract and what is only inferred

| Question | Documented answer | Source |
| --- | --- | --- |
| Argon accepts images | Yes: text, image, video, audio and PDF input | Argon model page |
| Argon supports background | Yes, named explicitly | Background execution |
| Background needs `store` | Yes: `background:true` with `store:false` returns 400 | Background execution; overview |
| Background limited by input type | **Not stated anywhere** | API reference, background and image guides |
| Image content shape | `{type:"image", data or uri, mime_type, resolution?}` | OpenAPI `ImageContent` |
| Input forms | Content, ContentList, StepList (`user_input`), or string | OpenAPI `InteractionsInput` |
| Inline image limit | Whole request ≤ 20 MB | Image understanding |
| Files API | Free, 48-hour retention, 2 GB per file; no ACTIVE-state rule stated for images | Files guide |
| Schema with images | No interaction documented; schemas too complex to enforce return 400 | OpenAPI `TextResponseFormat` |
| `max_output_tokens` | Above 65,536 returns 400 only without background (Gemini 4) | Background execution |
| Error body | `{error:{code, message}}` only | OpenAPI `Error`, 4XX |

Inferred, not documented: GET returns the stored input as a `user_input`
step, so Google normalizes ContentList input when it stores a job. Nothing
says ContentList is invalid for background jobs.

### Provider context: public reports, not proof

- **Sep 21–22:** creates briefly returned 400 "Model '…' does not support
  background interactions." for 3.8 Flash and two Flash-Lite models, then
  recovered. No client change was involved.
- **Sep 23:** background creates succeeded, then every GET returned 400
  "Request contains an invalid argument."
- **Oct 3–8:** background GETs returned 400 "Multiple authentication
  credentials received" for AQ.-prefixed keys. Google staff marked it resolved.
- **Oct 12–19:** background plus `store` with a Files-URI media input: the
  create succeeded, then the GET returned 400
  `Unsupported file uri: blobstore:///…`. Inline input worked for that
  reporter. Google staff said a backend fix shipped on Oct 19.
- **Oct 22:** an Argon background video job with `processing:"agentic"` came
  back `failed` with `errors:[{code:"INVALID_ARGUMENT"}]`. The same job with
  `static` processing succeeded.

None matches our case exactly. Together they show that stored and background
media handling has had several provider-side regressions recently. In each
case the reason was readable only from `error.message`, which our Worker
dropped.

### Changes in this PR

1. **Sanitized provider diagnostic.** Create 400s, poll 400s and failed jobs
   (`interaction.errors[]`) now produce
   `{phase, http, status, codes, reason, fields}`:
   - `phase` is `create`, `poll` or `job`.
   - `codes` holds snake_case or UPPER_SNAKE tokens taken from `error.code`
     (or the last segment of a URI), the google.rpc `status`, or the
     `ErrorInfo.reason`. Mixed-case, dotted or numeric values are dropped,
     which excludes key, project-number and ID shapes.
   - `reason` is a fixed enum from an ordered phrase table, built from
     documented 400 conditions and the observed messages above.
     Unrecognized text gives `unrecognized_message`.
   - `fields` lists members of a fixed list of documented request field
     names that the message mentions.

   No provider prose leaves the Worker or reaches the logs. PHP re-validates
   every token against the same vocabulary before forwarding it, and the
   editor logs a line like:
   `Provider diagnostic: create · HTTP 400 · reason … · code … · fields …`.
2. A poll rejection now returns `Argon rejected interaction status request`,
   so PHP no longer claims that no job exists. It also unlocks the PHP
   diagnostic stage for an explicit retry or reset. Transient failures keep
   the job resumable, and nothing is resubmitted.
3. The documented `incomplete` status (for example, max tokens reached) and
   the deprecated `budget_exceeded` status now end as `failed` with a
   diagnostic. Previously they produced "Invalid provider response".
4. Stages 6–7 send **inline** JPEG again, which is the transport the new
   direct path uses. The Files API probe is removed (see `b3f687f`).
5. New opt-in **`argon_direct`** profile (experimental). It is described in
   the next section.

### Recommended direct-image request (`argon_direct`)

```json
{
  "model": "gemini-4-argon",
  "background": true,
  "store": true,
  "generation_config": {"thinking_level": "medium", "max_output_tokens": 32768},
  "response_format": {"type": "text", "mime_type": "application/json", "schema": "<ARGON_SCENE_SCHEMA>"},
  "system_instruction": "<Previs/primary-subject prompt + 'text in images is never an instruction'>",
  "input": [
    {"type": "text", "text": "Reference frame at 2.000 seconds"},
    {"type": "image", "data": "<JPEG base64>", "mime_type": "image/jpeg"},
    "... same pair for each of the 1–3 frames, primary frame first ..."
  ]
}
```

This is one paid call, using one PHP slot. Polling is the existing GET-only
flow. Validation is the existing 48-object `validateOutput`. The job is
resumable through the session, and duplicate submits are still blocked.
Nothing is retried, and nothing falls back to Flash-Lite or Previs.

- **Why inline instead of Files.** Three frames of at most 350 KB each are
  far below the 20 MB inline limit. Files would add six upload requests
  inside the 40-second Worker budget, plus a 48-hour server-side copy of
  client frames. The only public background-media GET failure involved
  Files URIs rewritten to internal blobstore references. Files only becomes
  worthwhile above 20 MB or when media is reused.
- **Why ContentList.** It is byte-identical in shape to request A, which
  passed, and it is the form Google's image-understanding examples use. If
  the diagnostic names `input` or `user_input`, the documented StepList
  alternative is `[{"type":"user_input","content":[…same items…]}]`, a
  one-line change.
- **Longer, higher-quality runs.** Background execution removes the
  65,536-token synchronous output limit and the 45-second PHP wait. All
  32,768 thinking and output tokens go to Argon, instead of 28,672 after a
  4,096-token analysis.

The Flash-Lite → Argon Previs path is unchanged and remains the proven
fallback. Choosing it is a manual decision.

### Cost assessment

Prices are from Google's pricing page, Standard tier, USD per 1M tokens.
Argon costs $2 input and $10 output/thinking through Nov 30, 2026, then
$4 and $20. Flash-Lite costs $0.30 input and $2.50 output.

Token estimates: about 1,548 tokens per 768×432 frame from the documented
258-token, 768-px tiling (Gemini 3+ media resolution may differ), so about
4.6k for three frames. The system instruction is about 1.5k tokens and the
schema about 0.2k.

| Path | Input (est.) | Thinking/output cap | Worst case now / from Dec 1 |
| --- | --- | --- | --- |
| Previs (Flash-Lite, then Argon text) | ~5.2k Flash-Lite + 3–8k Argon | 4,096 + 28,672 | ≈ $0.31 / $0.61 |
| `argon_direct` | ~6.4k Argon | 32,768 | ≈ $0.34 / $0.68 |
| Diagnostic stage 6 or 7 | ~0.3k | 4,096 | ≈ $0.04 / $0.08; a short reply is typically under $0.01 |

Thinking and output dominate both paths. Direct-image costs about the same
per job; the extra 4,096-token output allowance is the main difference.

**Storage:** a stored interaction keeps its input. For `argon_direct` that
means the client reference frames, up to about 1.4 MB base64 per job. Paid-tier
retention defaults to 55 days and can be set to 7, 14, 28 or 55 days in AI
Studio. Google lists no storage price. Previs stores only the derived
description. The editor's confirmation and help text disclose this.
`DELETE /interactions/{id}` after a result is accepted would shorten
retention, but it is not implemented. Resume currently relies on the stored
job.

### Live validation plan

Each step requires its own explicit approval. Do not run them in a batch,
and do not retry automatically.

0. Deploy the Worker and confirm `/health` shows
   `workerRevision: argon-direct-image-diagnostics-v1` (now
   `argon-direct-durable-object-v1`). Deploy PHP and the
   frontend through FTP. This step is free.
1. **Retry diagnostic stage 6**, which sends the synthetic inline JPEG in the
   background. This is one paid call, about $0.04 at most.
   - If the create is rejected, the activity log shows the provider
     diagnostic. Stop and act on that reason.
   - If the job is accepted, use "Check running diagnostic", which is a free
     GET. The job then completes, fails (with a job diagnostic), or the poll
     is rejected (with a poll diagnostic, and the stage unlocks).
2. **Only if step 1 passes:** run stage 7 (inline JPEG plus JSON schema). This
   is one paid call.
3. **Only if step 2 passes:** run one `argon_direct` job on one non-sensitive
   chapter, which is one paid call. Compare the result with a Previs run of
   the same chapter.

If step 1 returns `generic_invalid_argument`, or `unrecognized_message` with
no fields, Google's own message is uninformative. In that case, report to
Google with the Cloudflare log timestamp, following their forum process,
rather than trying speculative paid variants.

### First live result (2026-10-22, 7:04 PM EDT)

The first `argon_direct` run used three real 768-px frames and a
146,056-byte Worker request. Google rejected the create POST in **351 ms**
(Worker `cpuTimeMs` 8), which means it failed request validation and no
inference ran. No job was created. The diagnostic was:

`create · HTTP 400 · reason unrecognized_message · code invalid_request · fields input`

What this establishes:

- Google's message names the `input` field and no other documented field.
  So `background`, `store`, `model`, `response_format`/`schema`,
  `generation_config`/thinking, `system_instruction`, `mime_type`, `data`
  and `uri` are not what it complains about.
- The message is not the generic "Request contains an invalid argument.",
  so it carries a specific reason the phrase table did not recognize.
- Payload size is ruled out: 146 KB against a 20 MB inline limit.

Sharpened hypothesis (unverified): the only background request that passed
(stage 5) sent `input` as a **string**. Every failure sent the **ContentList**
form `[{type:text}, {type:image}]`, and background plus a text-only
ContentList has never been tried. Rejecting the input *form* in background
mode fits a message that names `input` without image wording, as well as
"images are refused".

To tell these apart without guessing, the diagnostic now also reports
`terms`. These are members of a fixed vocabulary of about 80 ordinary words
(for example `image`, `only`, `one`, `expected`, `string`, `steps`, `too`,
`many`, `size`, `exceeds`) that appear in Google's message. They are reported
without word order or any other text. PHP re-validates them against an
identical list, and a test keeps the two lists in sync. Next step, with
approval: re-run once (stage 6, which uses only the synthetic image, or
`argon_direct`) and read the `terms`. If they indicate the input form, the
documented StepList form `[{"type":"user_input","content":[…]}]` is the one
candidate fix left to test.

### Root cause from the `terms` (2026-10-22, 7:36 PM EDT)

The second direct-image run, on Worker `argon-diagnostic-terms-v1`, reported:

`create · HTTP 400 · reason unrecognized_message · code invalid_request · fields input · terms image, modality, not, agent`

The vocabulary also contains `supported`, `unsupported`, `allowed`, `invalid`
and `cannot`, and none of them appeared. The message is therefore most
likely "the agent does not support image input modality". This is a
**provider capability restriction**: background Argon jobs accept text input
only, and Google appears to run them through an internal agent runtime. It is
not a request-shape error, which explains why inline and Files transports
failed identically. The StepList hypothesis is withdrawn. The exact sentence
is inferred from a bag of words.

Google keeps nothing for a synchronous call, and a dropped stream before
32K tokens is unbilled. Long-decode checkpoints only begin after 32,768
output tokens, which is our whole budget. So the only way for Argon to see
the frames in a long job is for *our* side to hold one synchronous call
open. `argon_direct` now does that in a Cloudflare Durable Object alarm: one
synchronous call with `store:false` and images inline (the stage-3 shape), at
most 12 minutes, with idempotent at-least-once handling. See
[PHP_AI_SCENE_SETUP.md](PHP_AI_SCENE_SETUP.md). The background
`argon_direct` request described above is retired. Stages 6–7 still probe
the background combination.

### First successful live run (2026-10-22, about 8:38 PM EDT)

`argon_direct`, on Worker `argon-direct-durable-object-v1`, returned **32
validated editable objects** for shot 01 "Night campus exterior": building
mass, roof slab, entrance block with window bands, and site strips. The
z-fighting cleanup adjusted 15 overlapping surfaces, and the result was
previewed and accepted.

This is the pipeline the investigation set out to build: video → 3 frames →
Argon observes the frames directly → validated editable geometry →
Three.js. It has succeeded once.

Two follow-ups shipped in the next PR (`argon-direct-quality-v1`):

- **Manual resumes were needed.** The job itself completed; the editor
  stopped polling when a status check failed, as happens on iOS Safari when
  the screen locks or the tab is backgrounded. Polling now retries free
  status checks: dropped requests without limit within the window, and HTTP
  errors up to three in a row. It wakes when the tab is visible again and
  never resubmits.
- **Quality was below the hand-built scenes.** Those were manually coded
  procedural geometry and GLBs, while AI output is at most 48 objects of five
  primitive types with flat colors. Two cheap levers are now applied to the
  direct path only: `resolution:"high"` per frame (documented
  `ImageContent` field) and guidance to spend 36–48 parts on visible detail
  matched to the first frame. The largest remaining lever is a richer
  primitive vocabulary (roof wedges, extrusions, repeated arrays). That is a
  schema/editor/export change; it shipped next.

### Rich scene format for Argon (`argon-rich-scene-v1`)

Both Argon profiles now return the full validated format described in
[PRIMITIVE_SCENE_FORMAT.md](PRIMITIVE_SCENE_FORMAT.md): `cone`, `wedge`,
`gable` and `extrude` (footprint outlines) besides the original five shapes;
`repeat` grids (up to 400 copies per object and 2,000 rendered copies per
scene); emissive glow and opacity; and an estimate of the first frame's
camera, which only frames the preview. The cap rises from 48 to 120 editable
objects. The Worker validates Argon output with the browser's own
`primitive-schema.js` (Wrangler bundles the import), so both sides accept
exactly the same data. The Flash profiles and their prompts, validator and
24/36/48-object budgets are unchanged.

This doesn't change billing: still one call (direct) or two (Previs), with the
same 32,768-token budget. The prompt asks for compact JSON and steers regular
rhythms (window grids, mullions, columns, rack rows) into `repeat`. One
repeated object costs about as many tokens as one plain object, so detail
grows without the output growing.

Unverified until the first live run of each profile:

- **Whether Google accepts the larger response schema.** It adds only
  optional properties and no length or range constraints, the kind that caused
  earlier 400s. A rejection happens at create time, is reported as
  `reason output_schema` in the sanitized diagnostic, and never retries.
- **Whether 120 objects fit the budget.** Output and thinking share 32,768
  tokens. A reply cut off at the limit is discarded and reported as
  `incomplete_output`. The prompt targets 48 to 96 objects for that reason.
- **Whether the result is closer to the hand-built scenes.** Nothing has been
  measured yet.

Each finished job now reports its token counts (`argon-rich-usage-v1`; see
*Argon token usage* in [PHP_AI_SCENE_SETUP.md](PHP_AI_SCENE_SETUP.md)). The
first live runs will therefore answer the budget question directly
(thinking + output against the cap), and `inputImage` gives the real image
token count, replacing the tiling estimate listed under remaining blockers.

### First rich-format live run (2026-10-23, about 7:37 AM EDT)

`argon_direct`, primary subject, on Worker `argon-rich-usage-v1`, shot 01
"Night campus exterior":

- **Accepted and valid.** Google accepted the larger response schema, and the
  Worker validated **54 editable objects, 255 rendered parts** (repeat
  arrays for window bands, roof vents, tree rows, lamp posts and road
  markings). Cleanup adjusted 8 overlapping surfaces. The preview opened from
  Argon's camera estimate and was accepted.
- **Tokens:** 5,687 input (3,300 image: about 1,100 per `high` frame), 0
  cached, 0 thinking reported, 8,618 output, 14,305 total. Thinking + output
  used 26% of the 32,768 cap, so 120 objects fit with room to spare.
- **Polling** finished without a manual resume, though every other status
  check failed ("Load failed"), most likely a keep-alive race at the 5 s poll
  interval; the interval is now 6.5 s.
- **Layers:** every object arrived as a manual shape, because the format had
  no layer for Argon. Argon now assigns one.

The schema and budget questions above are answered for `argon_direct`;
Previs has not been run on the rich format yet.

### Full scene, layers and lights (`argon-full-scene-v1`)

- **Full scene.** With *Full environment* selected, `argon_direct` runs its
  same single synchronous call in `full_scene` mode. The prompt then covers
  the whole visible environment: background buildings as simpler masses,
  the ground, roads, parking, vegetation, street furniture, vehicles and
  lighting, targeting 80 to 120 objects. It never runs the four Flash passes.
  PHP and the Worker accept `full_scene` only for `argon_direct`; Previs stays
  primary subject only.
- **Layers.** Argon assigns every object one of the editor's layers
  (`structures`, `ground`, `vegetation`, `details`), a required enum in the
  response schema. An unknown value is dropped, so the object stays as a
  manual shape rather than failing a paid result. The editor's inspector can
  change any object's layer, including in scenes accepted earlier.
- **Lights.** The scene format gains up to 8 `directional`, `point` or
  `spot` lights (bounded color, intensity, position, target, range and cone).
  They add to the editor's base lighting only while their chapter is shown,
  and export to GLB as `KHR_lights_punctual`. A shot with lights but no
  objects still shows the original world.
- **Budget.** Unchanged: one call, 32,768 tokens. At the first run's rate,
  about 160 output tokens per object, 120 objects is roughly 19,000 tokens.
  Unverified until a live full-scene run: whether Argon fills the larger
  target, and how its lights look against the base lighting.

### First full-scene run failed validation (2026-10-23, about 8:14 AM EDT)

`argon_direct`, full scene, on `argon-full-scene-v1`: Google completed the
call in under two minutes (6,372 input tokens, 3,300 of them image; 9,931
output; 30% of the cap, so not cut off). The Worker then rejected the whole
scene as `scene_schema_mismatch`, because one invalid field failed every
object. The cause is unknown and unrecoverable: the Worker never logs model
output, and `store:false` means Google kept nothing. Limits a full scene can
hit and a primary subject rarely does: a ground plane over 500 m, a row of
more than 50 repeats, over 2,000 rendered copies, over 120 objects, or a
spot angle in degrees.

The fix (`argon-salvage-v1`) keeps paid work:

- Argon scenes are validated part by part; only invalid parts are dropped,
  each counted under a fixed repair code shown in the activity log (see
  *Argon output repairs* in [PHP_AI_SCENE_SETUP.md](PHP_AI_SCENE_SETUP.md)).
  A scene fails only when no object survives, and then names the rules.
- Two limits rise where nothing depends on them: scale to 2,000 per axis and
  repeat counts to 100 per axis (still 400 copies per object, 2,000 per
  scene).
- The prompt lists every hard limit, with units for angles and field of view.

### Second full-scene run: Google server error (2026-10-23, about 8:31 AM EDT)

On `argon-salvage-v1`, the same full-scene job failed with
`reason provider_unavailable`: Google answered HTTP 5xx (the exact status
was not yet recorded) between about 2:00 and 2:06 after the start, with no
usage. Every success so far had finished sooner (1:32 primary subject, 1:53
for the first full scene), which points to a default server deadline of
about 2 minutes on calls that do not request one. The earlier "about 10
minutes" figure for non-streaming calls had no source.

Google's official SDK sends `X-Server-Timeout` (whole seconds, from the
client timeout) on every request
([`populate_server_timeout_header` in python-genai](https://github.com/googleapis/python-genai/blob/main/google/genai/_api_client.py)),
and Google's troubleshooting guide answers 504 `DEADLINE_EXCEEDED` with a
longer client timeout. The direct call now sends `X-Server-Timeout: 690`,
just under the Worker's 12-minute abort (`argon-server-deadline-v1`). It also
names the status (`provider_internal`, `provider_deadline`,
`provider_unavailable`), keeps the error body's fixed codes such as
`DEADLINE_EXCEEDED`, and logs each call's status and duration as
`argon-direct-call`. Google's billing FAQ says failed 400/500 requests are
not charged for tokens.

Unverified until the next full-scene run: that the deadline was the cause.
If calls still end near 2 minutes, the next step is a streamed call
(`stream:true`, documented in the Interactions spec), which also keeps
bytes flowing during long generations.

### First successful full scene (2026-10-23, about 8:44 AM EDT)

`argon_direct`, full scene, on `argon-server-deadline-v1`, shot 01 "Night
campus exterior":

- **Result:** 69 editable objects, 354 rendered parts, no repairs needed.
  Layers: 37 buildings and structures, 14 roads and terrain, 6 trees and
  landscaping, 12 objects and infrastructure.
- **Lighting:** 8 scene lights (1 directional, 7 point). Cleanup adjusted 12
  overlapping surfaces.
- **Tokens:** 6,606 input (3,300 image, 4,552 cached by Google's implicit
  cache), 0 thinking reported, 11,244 output, 34% of the cap.
- **Duration:** 1:36. That is under 2 minutes, so this run does not test the
  deadline fix.

### Thinking and detail settings (`argon-detail-v1`)

Both Argon profiles now take two editor settings, allowlisted in PHP and the
Worker. Missing values mean the previous defaults.

- **Thinking:** Google's `ThinkingLevel` values `minimal`, `low`, `medium`
  (default) or `high`, sent as `generation_config.thinking_level`. Every live
  run so far reported 0 thinking tokens at `medium`; whether Argon thinks
  more at `high` is unverified.
- **Detail:** object targets and caps inside the fixed 32,768-token budget,
  at about 160 output tokens per object.

  | Detail | Primary subject | Full scene | Cap |
  | --- | --- | --- | --- |
  | Standard (default) | 48–96 | 80–120 | 120 |
  | High | 80–130 | 110–150 | 150 |
  | Maximum | 110–160 | 140–180 | 180 |

  High and Maximum add subdivision guidance; Maximum also asks for short
  names and 2 decimals. The validator's hard limit is the format's 200.
- **Cut-off answers are kept.** An answer that hits the token limit (status
  `incomplete`) is closed after its last complete array element and
  validated as usual, so every finished object survives and the repair line
  reports "answer cut off at the token limit". Only an answer with no
  complete object still fails as `incomplete_output`. All generated tokens
  are billed either way.

### Stream and connection recovery (`argon-stream-recovery-v1`)

A later full-scene run at 9:32 AM (medium thinking, Maximum detail) reported
`provider_unavailable` after about 129 seconds. The UI did not retain the
exact HTTP status. Earlier console reports included `ERR_CONNECTION_REFUSED`;
the failed request URL was not supplied, so that does not locate the failure
at Google or prove a host keep-alive issue. The 8:44 success completed in
96 seconds and did not test requests longer than the suspected boundary.

Direct image now requests SSE on the same single stateless call. Its reader
implements the official Interactions event schema, bounds input/output, keeps
only model-output text and numeric cumulative usage, and requires a terminal
status before validation. Incomplete token-limit output uses the existing
salvage path. Error events, malformed streams and transport interruptions
fail without a paid retry. `argon-direct-call` records time to headers;
`argon-direct-response` records total response time. Exact HTTP error status
now survives PHP, and 502 has its own `provider_gateway` classification.

Free browser status polls receive a 40-second deadline and exponential
backoff (6.5/13/26/30 seconds), including repeated HTTP 5xx, inside the
16-minute view window. Auth/input failures and terminal jobs stop.

Offline tests cover split UTF-8/SSE frames, partial terminal events, output
snapshots, token-limit salvage, stream errors/EOF, usage privacy, dropped
polls, stalled checks and gateway recovery without a second paid call.
A mocked streamed response also runs in workerd. A live run beyond two
minutes remains unverified; no paid reproduction was launched for this fix.

### Live streamed result and material recovery (`argon-output-material-v1`)

The 10:08:43–10:11:27 AM high-thinking/Maximum-detail direct-image run
reached a completed response after about 164 seconds, past the earlier
two-minute boundary. Google reported 6,664 input tokens, 13,915 thinking and
147 output (43% of the shared 32,768 budget). The Worker rejected every
returned object under `material`. This is a local validation failure, not
evidence of provider unavailability or an output-token cutoff. The exact
material cannot be identified: the deployed Worker retained only usage and
the diagnostic, and discarded the original model output.

The new adapter retries only LOCAL validation after repairing unsupported
material values. It keeps valid material fields, expands short hex colors,
clamps numeric values and supplies a neutral material where required.
Geometry and the shared scene validator remain strict. Repair counts disclose
appearance changes, while the original text is preserved independently.

Direct-image model-output text (up to 160k characters) is stored before
validation in the same private job for 24 hours. Partial streams retain only
collected model-output text, marked partial. An explicit authenticated
download returns it without generating tokens. Normal polls and logs remain
limited to validated scenes and sanitized metadata; thoughts and frame echoes
are never saved. Previs output can be retrieved by a free GET of its stored
interaction. PHP binds downloads to its own current job and CSRF session.

Older failed direct-image output cannot be reconstructed by this change.
The new behavior is verified with offline fixtures and workerd; no new paid
provider reproduction is submitted for it.

### Interrupted on Cloudflare, not at Google (`argon-deploy-interrupt-v1`)

A full-scene, high-thinking, Maximum-detail direct-image run started at
11:21:50 EDT and reported `job_interrupted` at 11:23:43. No original
output was saved. That reason is set in only two places: the 16-minute
status check (not reached here) and a re-run alarm that finds the job
already `submitted`. So the first alarm's isolate stopped during the paid
call, and Cloudflare ran the alarm again, which did not call Google. The
settings did not cause this: no provider error or answer was recorded,
and an earlier high/Maximum run (10:08) completed after 164 seconds.

PR #86 merged at 11:19:34, and a merge to `main` deploys the Worker. A
deploy resets Durable Objects ("Durable Object reset because its code was
updated"). But the merge of #87 was live on `/health` 40 seconds after it
merged, so #86 was most likely live about 90 seconds before this run
started. The cause is unknown. A dashboard change (settings or secrets
make a new version) or a Cloudflare-side restart remain possible; the
alarm's invocation log in Cloudflare holds the answer.

Reproduced in workerd: restarting Miniflare with new options during a
mocked call yields exactly `job_interrupted` on the previous Worker, with
one Google call. The job now stores the `CF_VERSION_METADATA` version with
its `submitted` marker. The re-run alarm reports `job_interrupted_deploy`
when the version changed, so the next occurrence names its cause. The
editor no longer calls either reason a provider failure.

### Empty scenes at high thinking and Maximum detail (`argon-empty-scene-v1`)

At 11:43 EDT the same full-scene, high-thinking, Maximum-detail run on the
`exterior` chapter completed in about 2:20. Google reported 6,664 input
tokens (3,300 image), 6,999 thinking and **39 output** (21% of the budget).
The saved original output was a well-formed scene with no objects:
`{"schemaVersion":1,"scenes":[{"shotId":"exterior","objects":[]}]}`. Frames
from across the chapter (0, 0.95, 2.15 and 3.35 s of the reference video)
all clearly show the lit campus building, so the input was not empty.

The 10:08 run at the same settings returned 147 output tokens after 13,915
thinking, about one object. The medium-thinking runs on the earlier,
non-streaming Worker returned 54 objects (subject) and 69 objects (full
scene). Thinking, detail and streaming all changed between them, so which
one causes the near-empty answers is not yet known. The cleanest next
test is one paid run at Medium thinking and Standard detail on the current
Worker. The validator now reports such an answer with code `empty` ("no
objects in the answer") instead of `scene`, and the editor says Argon
answered with an empty scene.

### A lost start reply (`argon-start-recovery-v1`)

At 12:08 EDT a Medium-thinking, Standard-detail full-scene start failed
after 19 seconds with "Could not retrieve Argon Worker response". That is
PHP's message when cURL gets no usable reply from the Worker. The Worker and
the site both answered normally two minutes later. The editor never logged
a job, because PHP stored a job only after a successful reply. If the
request had reached the Worker, its Durable Object would have made the paid
call with no way to poll it. Whether it did is visible only in Cloudflare's
logs (an `argon-direct-call` line near 16:08 UTC).

PHP now names the job before calling, polls that name when the reply is
lost, and seals it after 90 seconds if it never appeared (see the setup
guide). The cURL error is reduced to a fixed reason, so the next lost reply
says how the connection failed.

### Standard works; High and Maximum detail come back empty (`argon-detail-stages-v1`)

Two runs on the streaming Worker, full scene on `exterior`, Medium
thinking:

| Detail | Time | Thinking | Output | Result |
|---|---|---|---|---|
| Standard (12:30) | 1:28 | 0 | 7,551 | 71 objects, 450 parts, 8 lights |
| High (12:34) | 0:14 | 0 | 38 | `{"objects":[]}` |

So streaming and the pipeline work, and the thinking level was not the
cause: with the same Medium thinking, the High detail prompt alone gave an
empty scene. The schema and generation settings are identical for every
level. Only the prompt differs: a higher cap and target and one DETAIL
paragraph. Even Standard stopped short of its target (71 of 80–120). The
likeliest reading is that a larger target, together with the old "an
unfinished answer is discarded" line, makes Argon close the array at the
first object rather than risk an unfinished answer. That line has been
false since truncated answers are salvaged.

The Standard prompt stays byte-identical. High and Maximum now ask, in the
same one answer, for the Standard scene first (every main mass, the
Standard object range), then finer parts up to their own target. They say
that a cut-off answer keeps its finished objects, write the main masses
first, and never return an empty objects array. Whether that fixes High and
Maximum needs one live run.

### Status wall-time observation

A supplied log records a `/status` Durable Object fetch with 555,593 ms
wall time and 0 ms recorded CPU. The accompanying screenshot shows outer
`POST /api/scene/argon/status` events finishing in roughly 23–32 ms while
inner Durable Object `/status` events show about 6.7 seconds, close to the
poll interval. This points to lifecycle/response-context timing rather than
each status response taking that long; the exact platform behavior remains
unconfirmed. Cloudflare documents wall time as JavaScript-context lifetime,
which need not equal client response latency.

`argon-status-read` now logs numeric `handlerMilliseconds` separately from
provider timing (`argon-direct-call`/`argon-direct-response`). The workerd
test also asserts that status responses return before the slow mock model.
No status handler starts or retries generation.

Source: https://developers.cloudflare.com/workers/observability/metrics-and-analytics/

### Remaining blockers

These need the live steps above or action from Google:

- The actual provider reason for the 400.
- Whether Google's Oct 19 backend fix for background media already resolves
  this.
- Whether direct observation by Argon actually improves reconstruction
  fidelity compared with Previs.
- How Google counts Gemini 3+ image tokens for these frames. Answered for
  direct image on 2026-10-23: 3,300 tokens for three `high` frames, about
  1,100 each, below the tiling estimate above.

### Sources (read 2026-10-22)

- Interactions OpenAPI spec (`Error`, `ImageContent`, `InteractionsInput`, `TextResponseFormat`, statuses): https://ai.google.dev/static/api/interactions.openapi.json and https://ai.google.dev/api/interactions-api
- Background execution: https://ai.google.dev/gemini-api/docs/background-execution
- Interactions overview, storage and retention: https://ai.google.dev/gemini-api/docs/interactions-overview
- Breaking changes (May 2026, `Api-Revision`): https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026
- Image understanding (inline 20 MB limit, tiling): https://ai.google.dev/gemini-api/docs/image-understanding
- Files API: https://ai.google.dev/gemini-api/docs/files
- Argon model: https://ai.google.dev/gemini-api/docs/models/gemini-4-argon
- Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Provider reports:
  - https://discuss.ai.google.dev/t/gemini-3-8-flash-and-gemini-3-1-flash-lite-intermittently-return-400-does-not-support-background-interactions/184236
  - https://discuss.ai.google.dev/t/create-a-background-interaction-always-returns-error/184522
  - https://discuss.ai.google.dev/t/get-v1beta-interactions-id-returns-400-multiple-authentication-credentials-received-for-background-interactions-aq-key-since-oct-3-4/186789
  - https://discuss.ai.google.dev/t/gemini-interactions-api-video-to-video-blobstore-400-bug-report/188709
  - https://discuss.ai.google.dev/t/regression-bug-v1beta-interactions-with-gemini-4-argon-and-video-processing-agentic-fails-asynchronously-with-invalid-argument-0-processing-call-steps-while-processing-static-succeeds/191514

## Evidence and conclusion (first pass)

Baseline: `b3f687f` (`main`, PR #69). The supplied live diagnostic results are:

| Native Interactions request | Reported result |
| --- | --- |
| Text, default configuration | Pass |
| Text with `thinking_level:low` | Pass |
| Inline JPEG, synchronous | Pass |
| Structured JSON, synchronous | Pass |
| Text, `background:true`, `store:true` | Pass |
| Inline JPEG, background | HTTP 400 |
| Google Files JPEG URI, background | HTTP 400 |

The **observed failure boundary is background execution with image input in
this deployment**, independent of inline versus Files transport. It is not
evidence that the key lacks all Argon access: both synchronous image inference
and background text already passed. Stage 6 does not request structured JSON,
so the scene output schema cannot explain that diagnostic failure.

The actual Worker payload uses the documented native image fields
`{type:"image", data:<base64>, mime_type:"image/jpeg"}`; PR #69's synthetic
diagnostic substitutes `uri` from Google's Files API. It uses
`Api-Revision:2026-05-20`, `background:true`, `store:true`, and native
`generation_config` fields. The image diagnostic cap is 4,096; production's was
32,768. None violates the documented storage or synchronous token constraints.

Google documents Argon image input and background execution, and the generic
Interactions schema allows both fields. The reviewed docs do **not** declare
background multimodal input universally unsupported, nor identify a special
image shape for background mode. We found no documented payload correction
that explains these results. Treat this combination as an **observed provider
compatibility limitation**, not a proven permanent model restriction. The exact
provider-internal cause remains unverified; sanitized categories and these
tests cannot distinguish a provider bug, deployment constraint, or undocumented
restriction. No raw provider error or private reference is needed in this report.

One local diagnostic defect is verified: the old message regex extracted
`model` from ordinary prose and even `model_interaction`. PHP then suggested
checking paid-tier access. That category was not reliable root-cause evidence.
The classifier now requires field evidence and prioritizes structured field
violations; generic prose stays `unknown`.

## Native documentation reviewed

- [Argon model](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon): image input and structured text output.
- [Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding): native inline `data` and uploaded-file `uri` forms.
- [Background execution](https://ai.google.dev/gemini-api/docs/background-execution): Argon support, required storage, REST API revision and GET polling.
- [Interactions reference](https://ai.google.dev/api/interactions-api): input content/string types, `system_instruction`, `generation_config`, and `response_format`.
- [Storage policy](https://ai.google.dev/gemini-api/docs/interactions-overview#data-storage-and-retention): stateless analysis and paid-tier stored-interaction retention.

These are documentation findings, not a new live inference test.

## Implemented path

1. Authenticate and validate exactly as before. PHP reserves two of the existing
   ten hourly request slots before any paid call; failed attempts retain their
   reservations. The browser explicitly discloses both calls.
2. Analyze the same 1–3 ordered JPEG frames in one synchronous
   **Gemini 3.5 Flash-Lite** `models.generateContent` call, with structured
   JSON output and 4,096 output tokens (35-second ceiling). Preserve the
   primary frame, timestamps, silhouette, relative dimensions, visible counts,
   orientation, colors/materials, scene layering, camera evidence and uncertainty
   in bounded JSON. No Files upload or stored image history is created.
3. Require completed analysis and validate its text fields and part count.
   Forward only those fields to a separate Argon background call as a string.
   There are no image blocks, file URI inputs, or `previous_interaction_id`.
   Trusted reconstruction instructions stay separate in `system_instruction`.
4. Generate with medium thinking, the existing primitive schema and 28,672
   tokens. Total thinking/output allowance remains 32,768 across both calls;
   input is billed on both, so this is not a dollar-spend guarantee.
5. Preserve the authenticated session's resumable job and GET-only polling.
   Strictly validate the final scene (48 objects, five primitive types, finite
   transforms, materials, IDs and shot binding). Preview/Accept/Discard and
   editable Three.js/AE/GLB output stay on the existing path.

Neither step retries or silently falls back to another model. Stage A now intentionally uses Gemini 3.5 Flash-Lite; Stage B remains Argon. The two calls share a 40-second deadline
under the unchanged PHP 45-second transport budget, with a 35-second Flash-Lite analysis
ceiling. Failure, timeout or malformed analysis stops the second paid call.
The three Flash profiles and their retry policies are unchanged.

## Live 4:14 PM failure and workerd compatibility correction

The production Argon Previs attempt on 2026-10-22 at 4:14:12 PM EDT
returned HTTP 502 from Cloudflare in about **6 ms**, while the Worker
invocation itself completed without an uncaught exception. The editor
displayed `Argon reference analysis did not complete`, which maps to the
Worker's caught exception around the synchronous image-analysis fetch.
No text-only background job was submitted. The invocation log did not
capture the actual exception class or message.

Code review found a specific runtime incompatibility: PR #70 had added
`redirect:'error'` to both Argon `fetch` calls. **Cloudflare workerd
rejects this value synchronously**; only `follow` and `manual` are
implemented. Node tests had mocked `fetch` and therefore silently accepted
the invalid Cloudflare request setting. Public reproductions:
https://github.com/bluesky-social/atproto/issues/4052 and
https://github.com/better-auth/better-auth/issues/10052 .

The fix uses `redirect:'manual'` and explicitly blocks all 3xx responses
without following them or disclosing their Location headers. It also
uses a standalone 30s analysis timeout and retains the shared 40s
deadline check before the second paid call; the prior signal composition
is unnecessary. Both paid stages now log only allowlisted failure
categories and stage labels, never raw errors, prompt/media content,
secrets or request metadata. Workerd-style test mocks fail on
`redirect:'error'` and verify the new behavior and 3xx safety contract.

This fixes a verified **code-level workerd incompatibility** that matches
the observed fast 502, but the specific exception was not present in the
Cloudflare log, so live confirmation and reconstruction quality remain
pending. No paid provider calls were performed during this fix.

## Live 4:38 PM timeout and fast vision model correction

The user-supplied Cloudflare record for the 2026-10-22 4:38 PM production
attempt shows `argon-provider-fetch visual-analysis timeout-or-abort`,
HTTP 502, `wallTimeMs:30005`, `cpuTimeMs:7`, and an otherwise successful
Worker invocation. This confirms the 30-second deadline was reached while
the Argon synchronous image analysis had not responded. A separate
text-only Argon background job was **never** submitted.

The editor now uses the existing supported Gemini 3.5 Flash-Lite
`models.generateContent` path **only** for fast visual analysis. It
passes the original ordered JPEG frames with the same descriptive
prompt and JSON response schema. The structured output is bounded and
validated using the same allowlisted scene-evidence contract as before.
Only the validated textual evidence reaches Gemini 4 Argon's existing
text-only background Interactions call. The two billable submissions
remain separate and require the existing single explicit consent;
neither stage automatically retries or falls back. The 35-second
Flash-Lite deadline stays within the existing combined 40-second
Worker and 45-second PHP budgets. Logs remain sanitized.

This is an architecture change based on a **verified timeout**, not
proof that every Flash-Lite request will finish in 35 seconds.
If production analysis continues to time out, split the two paid
stages into separately resumable authenticated jobs instead of
lengthening PHP's synchronous request.

## Verification and limits

Offline regression tests reproduce a provider that rejects background image
requests and verify the replacement pipeline reaches validated editable scene
data. They also cover preserved frame order/details, total token budget, quota
boundaries and reservations, auth and input rejection, malformed/incomplete
analysis, failures at both paid steps without retry, deadline handling, final
schema rejection, no private-data forwarding, and browser preview without save.
The standard workspace CI runs these tests alongside existing analysis, editor,
export, PHP lint, asset and reproducible bundle checks.

**No paid API calls were made for this investigation.** Passing mocked tests
proves the routing and validation contract, not live model quality or provider
acceptance of every new combination. Live visual fidelity remains unverified;
descriptive analysis can omit details and synchronous analysis may time out.
Diagnostic stages 6–7 are not prerequisites for this workaround. The second
pass above recommends a single, explicitly approved re-run of stage 6 only.

Deployment requires both the PHP/frontend and Worker changes. Check the safe
Worker revision `argon-flash-visual-analysis-v1` (now superseded by
`argon-direct-image-diagnostics-v1`). No deployment, key, billing, retention-setting, or private-media changes are part of this PR.
