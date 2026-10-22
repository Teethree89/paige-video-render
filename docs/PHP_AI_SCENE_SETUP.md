# Paige AI generation: private PHP configuration + Cloudflare Worker

## Intended server layout

Private file **created manually in the hosting control panel**:

`/www/certificates/paiver.php`

Public editor, PHP proxy, and JavaScript deployed from GitHub via FTP:

`/www/paige-lighthouse.50webs.org/Indium/paiver/`

**Do not place the private `paiver.php` inside the editor directory.** The FTP account currently lands in the editor directory and cannot be assumed to have access to `/www/certificates/`. This repository contains only `docs/paiver.config.example.php` with placeholders, never the real token.

## 1. Verify the Worker

The repository contains `wrangler.toml` with `name = "paige-video-render"` and `worker/scene-worker.mjs`. Cloudflare Workers Builds defaults to `npx wrangler deploy` in the repository root when connected to GitHub. In Cloudflare dashboard → Workers → `paige-video-render` → Settings → Builds, verify the root directory is the repository root and the deploy command uses Wrangler. Production should use the `main` branch.

Worker runtime **Secrets** (both already configured by the user):

- `GEMINI_API_KEY`: Gemini provider key.
- `SCENE_ACCESS_TOKEN`: long private shared token.

Do not duplicate their values in `wrangler.toml` or `worker/scene-worker.mjs`. The Worker has `GET /health` for anonymous operational status and `POST /api/scene` for bearer-authenticated generation. There is **no CORS allowlist**: browsers cannot call the private endpoint from other origins; access goes through the PHP proxy.

### Cloudflare production deploy and encrypted binding readiness

Cloudflare Workers Builds uses `npx wrangler deploy` for production and `npx wrangler preview` for pull-request previews. The Worker keeps `[previews]` for previews but deliberately **does not** declare `[secrets].required`: Wrangler rejected production Builds with "required secrets have not been set" even after the dashboard was configured. No secret values are copied into GitHub, deployment commands or the Wrangler configuration. Cloudflare documents that existing encrypted secrets are normally preserved across Wrangler deployments.

After production succeeds, open the actual Worker URL and visit `/health`:

- HTTP **200** with `{"ok":true,"service":"paige-scene","ready":true}` means the **deployed runtime can see both secret bindings**. It does **not** confirm the Gemini key is valid or quota available.
- The `workerRevision` field in `/health` is an explicit deployment indicator. `argon-flash-visual-analysis-v1` identifies the two-step Argon path: synchronous visual analysis followed by text-only background geometry. The existing three Flash profiles and Medium capacity retries remain unchanged. If it is absent, GitHub's successful **FTP publisher** did not update the separate Cloudflare Worker; check **Cloudflare Workers & Pages → paige-video-render → Deployments/Builds**, production branch `main`, and the latest Wrangler build result. Do not infer Worker deployment or live inference success from PHP/FTP success.
- Lite and 3.8 Low retain at most **one additional** Gemini request on HTTP 500/502/503/504 (700ms pause, one shared 45s deadline). Medium can make **up to three total attempts**, with a roughly 1s then 2s delay and bounded jitter, **only if the second attempt also returns HTTP 503**. Other upstream 5xx stop after two attempts. Every attempt shares Medium's 70s deadline, and retries never start with less than 10s remaining. HTTP 429, permission and malformed-request failures never retry. The editor's HTTP 502 may represent PHP relaying provider 5xx; the distinct safe `Gemini is overloaded (upstream 503)` message means all permitted 503 retries were exhausted. Cloudflare's sanitized `gemini-provider-http` logs record status and attempt without raw bodies or API keys. A single PHP session-quota request can cause up to three Gemini API attempts, potentially affecting Google quota and billing.
- HTTP **503** with `{"ok":false,"service":"paige-scene","ready":false}` means the runtime is missing one or both bindings. In Cloudflare Dashboard → Workers & Pages → `paige-video-render` → Settings → **Variables and Secrets**, confirm the two names exactly match `GEMINI_API_KEY` and `SCENE_ACCESS_TOKEN`, that their type is **Secret**, and click **Deploy** to save the production version. Never paste the values into CI logs or the public repository.
- If the build is red, inspect the exact latest Cloudflare build log and resolve the reported issue before testing PHP.

The public `/api/scene` endpoint also returns HTTP 503 if either binding is missing; it never allows unauthenticated generation as a fallback.

### Non-hosted file location on shared hosting

The 50webs file manager shows `/www/certificates/paiver.php`, but that path might be a virtual display path rather than PHP's literal filesystem path. The public `scene-proxy.php` resolves its private configuration from two server-only candidates: first `dirname(__DIR__, 3) . '/certificates/paiver.php'` (relative to the installed editor), then the original `/www/certificates/paiver.php`. It never searches inside the public editor or accepts a user-supplied path.

The private file's `644` mode is typically readable; **do not change it to `777`**. Confirm `certificates/` also has traversable directory permissions (typically `755`). If a PHP GET still returns `Private server configuration is not available`, the likely remaining causes are a restrictive `open_basedir` or separate runtime filesystem mapping; inspect the host's PHP `open_basedir` setting or request 50webs assistance. Never copy this token-bearing file to a public URL as a workaround.

## 2. Create the private file in the hosting panel

Create the new file **`/www/certificates/paiver.php`** by copying [the placeholder-only example](paiver.config.example.php):

```php
<?php
return [
    'scene_access_token' => 'PASTE_THE_SAME_SCENE_ACCESS_TOKEN_HERE',
    'editor_passphrase' => 'CHOOSE_YOUR_OWN_UNIQUE_PASSPHRASE_HERE',
];
```

The Worker URL is pinned in `scene-proxy.php` and does not belong in the private configuration. Replace the token placeholder with exactly the long token bound to `SCENE_ACCESS_TOKEN` in Cloudflare. Choose a new, unique **memorable passphrase of 16+ characters**, not your FTP password, Cloudflare password, or other existing secret. The short sign-in interface asks for this passphrase once per PHP session. The private PHP file is deliberately server-only and contains plaintext secrets; ensure it is not HTTP accessible and use restrictive filesystem permissions such as `0600` when supported by the host.

**You must create that private file manually.** The repository/FTP publishing job cannot and must not upload it.

### Generation activity and geometry cleanup (client-side)

The editor's **Generation activity** panel shows honest stage events:
authenticated session checked, video JPEG frames sampled, the selected
model/profile, each environment pass dispatched/completed, schema validation,
post-generation overlap cleanup, and the preview result. While a synchronous
Gemini request is running, an elapsed-seconds indicator updates without claiming
to receive private chain-of-thought or actual partial Gemini construction steps.
All provider retries happen server-side within one response; the activity log
cannot show individual 503 attempts until the request has returned. A future
async implementation can expose genuine server-side stages.

After strict scene JSON validation and **before** a proposed scene is previewed,
`primitive-cleanup.js` runs an entirely deterministic, no-API-cost cleanup pass:
it removes only duplicate shapes with matching primitive, material, layer and
transform, and moves small overlapping planes/thin rectangular detail pieces
off large coplanar surfaces by a small offset. It honors rotated planes and
thin facade trims, preserves semantic IDs and other chapters, and intentionally
leaves deep intersections/ambiguous surfaces untouched. It is **not** a general
mesh intersection repair utility.

- **Re-run z-fighting cleanup on preview** is available only while a new AI
  proposal is pending; it updates the temporary 3D view, not the timeline. Repeated
  runs should make zero further adjustments if nothing has changed.
- **Clean up saved chapter geometry** operates on the currently selected
  already-accepted primitive chapter and saves only when it makes a change.
  It cannot run over an unaccepted proposal. Export the timeline JSON to
  preserve a backup before subsequent manual edits.
- The activity feed is not persisted and has a bounded 50-line history.
  It contains no authentication secrets, provider response bodies, images,
  or Gemini's hidden reasoning.

### No-generation Argon model check

Before another paid Argon Previs test, use **Check Argon model visibility
(no generation)** in the authenticated AI panel. The browser calls
`argon_check` through PHP using its normal secure cookie, same-origin policy
and CSRF. PHP proxies a private Worker `/api/scene/argon/check` request that
performs **GET** `/v1beta/models/gemini-4-argon` with the configured
`GEMINI_API_KEY`. Only an allowlisted `listed` / `not_listed` result
is returned; no key value, provider error, source footage or model inference
is transmitted to the browser. This check does **not** count against the
PHP generation quota and does not incur generation tokens.

**Important:** visibility in `models.get` is a metadata check, **not proof**
that this project can submit Argon Interactions requests, that its billing
tier is active, or that the complex previs request is accepted. A missing
model is useful evidence to verify the API key's underlying project in
Google AI Studio; a listed model means only that the key can fetch metadata.
If listed but Argon still fails, inspect sanitized Worker diagnostics and
the selected project's model-specific rate limits; do not blindly resubmit
paid work or claim model access is confirmed.

### Staged Argon API smoke diagnostics (explicit, potentially paid)

The AI panel includes **Run stage N (paid)**, **Check running Argon
diagnostic (no new charge)** and **Restart diagnostics**. This is intentionally
separate from the existing 48-object Argon Previs generation. Seven fixed
single-submission stages must be manually confirmed, in order:

1. Minimal **text**, no generation config — baseline model/API access.
2. The same text, now explicitly adding **native**
   `generation_config.thinking_level = low`, `max_output_tokens=4096`.
   No OpenAI `reasoning_effort` or `thinking_budget` is forwarded.
3. A verified hardcoded **32x32 synthetic JPEG**, provided as documented
   Interactions `{type:image, data:base64, mime_type:image/jpeg}`.
   The original fixture was malformed: its decoded bytes did not end with the
   required JPEG `FF D9` marker. The replacement was generated and decoded
   offline with Pillow. CI pins its SHA-256, JPEG markers and dimensions.
   This test never samples or transmits a private client's video.
4. **Structured JSON** with a trivial `{ok:boolean}` schema, using text input.
5. **Minimal background text** using the native thinking settings that
   passed Stage 2, plus `background:true, store:true`. No JSON or image.
6. **Background synthetic JPEG through Files API** (not inline), with no
   JSON schema. Uploads a small verified synthetic JPEG to Google's Files
   API, validates the returned URI against a trusted Google host/path, and
   includes `{type:'image',uri:...,mime_type:'image/jpeg'}` in the interaction.
   This checks whether changing image transport avoids the background rejection.
7. **Background Files API JPEG + structured JSON**. The synthetic image
   uses the same trusted-URI upload route, with the simple JSON schema.
   Uses `store:true`. Production now analyzes inline frames synchronously and
   sends only descriptive text to its background request.
   Every background step reuses its session-held Google interaction ID while
   polling; a GET never submits another generation request.

Stage 5 (background text-only) succeeded on the paid project.
Stage 6 (background + inline synthetic JPEG) received HTTP 400, classified
ambiguously as a model configuration problem. Both background execution and
images work separately, so the **combination** is the suspect. Stage 6 now
uses the documented Files API URI input instead of inline base64; if that
passes, production can be adapted in a separate, reviewable patch rather
than immediately uploading proprietary customer images. The Files API
retains uploaded media for **48 hours**. Both diagnostic stages upload
only the synthetic 32x32 test JPEG. The existing generation flow and
client-footage privacy behavior are unchanged; no fallback triggers
automatic paid requests.

The Worker fixes model, prompt, input and token limits for every stage.
No custom browser-supplied prompt, provider URL, job ID or thinking parameter
is permitted. PHP enforces the order, stores only stage and safe status in
the private session, limits diagnostic submissions to **10 in 24 hours per
session**, and halts on error. After a failure, the same failed stage can be
**explicitly retried** with a new confirmation and `retry:true`; already-passed
stages do not need replaying. A separate confirmation is required before
each possible paid submission; nothing runs automatically.

A rejected HTTP 400 should result in a sanitized field-specific error.
A synchronous response timeout (~30s Worker budget) is **inconclusive**:
it may reflect latency rather than lack of model support. Never infer a
successful paid job merely from metadata visibility. If a stage fails, do
not run later stages; inspect the sanitized diagnostic category first.
Browser reload preserves stage state when the original PHP session survives.

This isolated suite uses Google native Interactions API, not a router or Vertex
AI. Gemini 4 Argon **does** support `thinking_level` low/medium/high in the
native `generation_config` per Google's API reference. The stages separate
that field from minimal text and images rather than removing it globally.
Tests in CI stub provider calls and never consume paid API credits.

### Paid Argon Previs (opt-in background generation)

The `argon_previs` model profile uses **up to two potentially billable calls**, **Primary subject only**,
to Google's Gemini APIs. Stage A uses **Gemini 3.5 Flash-Lite** via `models.generateContent` and the
existing encrypted `GEMINI_API_KEY`. A synchronous image-analysis call produces the same bounded visual-evidence contract. Stage B uses **Gemini 4 Argon** via the native Interactions API as a text-only background task to turn that evidence into editable geometry. See [the investigation](ARGON_BACKGROUND_IMAGE_INVESTIGATION.md) for
the observed background/image rejection and the limits of the diagnosis.
It uses a descriptive Previs/Runway Prep prompt targeting
silhouette, hero masses, facade rhythm, clean grounded forms, and independent
editing of the 48-shape scene. It does **not** generate textures, C4D projects,
or Runway video itself; existing AE, GLB and MP4 outputs remain unchanged.
A C4D-native project/export pipeline is a separate planned development.

- Browser confirms both potentially billable calls and stored descriptive data.
  PHP `argon_start` reserves **two** of the existing 10 requests per session/hour
  before calling the Worker; a session with nine used slots cannot start Argon.
  Reservations remain consumed on failure. Poll/resume creates no new inference.
- Worker validates 1–3 inline JPEGs and primary-only scope, then sends one
  synchronous `models.generateContent` request to Gemini 3.5 Flash-Lite with
  `responseMimeType:application/json`, the bounded response schema, and a
  4,096 output-token cap. No native Argon thinking settings are used in Stage A. Its schema captures subject, composition,
  palette, camera motion, uncertainty and up to 32 visible subassemblies. The
  first frame remains primary even if timestamps are not chronological.
- Only completed, bounded, validated visual evidence reaches the second request.
  This uses `background:true`, `store:true`, `thinking_level:medium`, and 28,672
  thinking/output tokens. The combined ceiling remains **32,768**; input tokens
  for both requests are also billable. The input is a JSON **string**, with no
  media blocks, Files URIs or `previous_interaction_id` carrying image history.
  The final scene `response_format` includes the existing compact schema; the
  Worker still strictly validates all transforms, materials and the 48-object cap.
- Both calls share a 40-second Worker deadline inside the existing 45-second PHP
  timeout; Flash-Lite analysis is additionally capped at 35 seconds. Failure in analysis
  stops before background creation. No automatic paid retry, probe or fallback
  occurs at either stage. **Failed/timed-out requests may still incur charges.**
- Job ID lives **only** in the authenticated PHP session; JS submits
  `argon_status` with CSRF and receives only allowlisted job status/result.
  PHP retrieves Google status via Worker `/api/scene/argon/status` using
  its bearer token. Worker extracts only final `model_output`, then applies
  the same strict 48-object JSON schema check. Browser's existing automatic
  cleanup and preview/Accept/Discard follow normally.
- Browser checks status about every 5 seconds, up to 10 minutes per view.
  The **Resume previous Argon job** control is available after refresh or
  interruption if the same secure PHP session survives; no new paid request
  is made to resume. Another paid job cannot start while a queued/running job
  is associated with that PHP session. Job recovery is capped at 24 hours
  in PHP; Google stores background results according to its retention policy.
- **Client footage privacy:** The Flash-Lite vision pass uses a direct
  synchronous GenerateContent call, not a stored Interactions background job;
  client images are still processed by Google under the applicable API data policies. The background request
  stores only the derived visual description and generated result. Google's
  current documentation says paid-tier stored interactions default to 55 days,
  configurable in AI Studio to 7/14/28/55 days. A stateless `store:false` Argon analysis is no longer part of this flow.
  The background request continues using `store:true`; verify actual retention
  settings in Google AI Studio. No
  retention settings are changed by this implementation. Credentials, image bytes, analysis and raw provider errors are not
  logged or returned to the browser. The validated scene remains subject to the existing Accept flow.
- Google charges by input and output/thinking token usage; check the latest
  <https://ai.google.dev/gemini-api/docs/pricing>. Limit test spend and
  review usage in AI Studio before running client production sequences.
  There is no guaranteed spend cap just because a project was pre-funded.
- Deployment requires **both** Cloudflare Worker and 50webs FTP publisher to
  update. `/health.workerRevision=argon-flash-visual-analysis-v1` indicates the
  new Worker path; if FTP deploys first, do not test Argon until Worker revision
  matches.

Worker error classification: on provider HTTP 400/422, parse only explicit
field *paths* in structured `google.rpc.BadRequest.fieldViolations` or a
recognizable field path in the message. The two distinct fields
`response_format.mime_type` (JSON output) and `input[n].mime_type` (JPEG
input) must **not** be conflated. An unscoped mention of `mime_type` or
`image` gives an **unknown Argon request error**, not a misleading image
diagnosis. The diagnostic image input already emits the exact base64/jpeg form shown
in Google's Interactions image docs for the synchronous analysis. Do not blindly encode base64 again or
prepend a data URI. Category logs and browser messages come from fixed
allowlists only: no provider message, frame data, image bytes or secrets
may escape the Worker. Generic 400s require checking private provider diagnostics
or introducing an explicit safe field-path category; never trigger automatic
paid retries.

A generic prose mention of `model` is not evidence of a bad model ID or missing
paid-tier access. Structured field violations take precedence over message text.
Stages 6–7 still test the **direct** background/image provider combination; they
are not prerequisites for the production two-step path and may still fail.
Do not replay the paid diagnostic sequence to validate this workaround.

Official API: <https://ai.google.dev/gemini-api/docs/background-execution>
and <https://ai.google.dev/gemini-api/docs/image-understanding>.

## 3. Public PHP proxy

`scene-proxy.php` is intentionally deployed next to `index.html` by the GitHub FTP workflow. It loads the absolute private path using PHP `require`, not a URL. It fails closed if the config, SSL, PHP sessions, cURL, valid Worker URL, or credentials are missing. It requires same-origin requests, an editor passphrase login, HttpOnly Secure SameSite session cookie, a per-session CSRF token, controlled 3-frame JPEG input, and a 10-request-per-session/hour quota limit.

The browser calls the proxy relative to the existing page (no CORS required). The proxy sends the Worker bearer token in server-to-server HTTPS requests; the token **never enters any client JavaScript**, HTML, localStorage, or the timeline JSON.

**Important:** The passphrase/session cap is an initial protection, not full internet-wide rate limiting: an attacker can create new sessions. Add Cloudflare Rate Limiting or Cloudflare Access protection and an IP/account-level rate limit before treating this as a public production API. Never remove authentication just to get it to work.

## 4. Connect and test

1. Check `https://<your actual workers.dev hostname>/health`. A deployed Worker responds `{"ok":true,"service":"paige-scene","ready":true}`; this does not guarantee Gemini quota.
2. Open the existing editor over **HTTPS**, select a draft chapter, and expand the Primitive Scene Editor.
3. Enter your editor passphrase under **AI Generate Scene · Gemini** and click **Unlock AI generation**.
4. Click **Generate 3D scene for this chapter**. Three JPG frames are sampled locally then sent through PHP → Cloudflare → Gemini.
5. Preview the proposed geometry. **Accept** saves it in your local editable timeline; **Discard** restores the previous primitives. Export timeline JSON to keep a portable backup.
6. If you see "PHP proxy unavailable", test the PHP handler and read permissions for the private config path; 50webs account PHP/cURL capabilities must be confirmed. If Cloudflare deployment is not yet live, check Workers Builds and required runtime secrets.

## Security and provider use

- Only non-secret Worker code and the public proxy live in GitHub.
- The PHP template contains placeholders and may be included in the downloadable project ZIP without leaking credentials.
- Cloudflare Workers secret values remain configured privately in the dashboard.
### Full-scene environment reconstruction (four coherent layers)

The default **Full environment** mode generates one **chapter-local, persistent**
editable 3D environment with four bounded sequential Gemini passes:

1. `structures`: all visibly supported buildings, architecture, and structural/equipment masses
2. `ground`: roads, parking, paths, sidewalks, terrain and surface features
3. `vegetation`: observed trees, shrubs and landscaping (empty if none visible)
4. `details`: other visible infrastructure, vehicles, lights, fences and props

The exact **editor playhead frame** is always the first/primary frame sent in
each request, followed by two other sampled frames within the same chapter.
All four passes receive the same frames. After the first pass, subsequent
passes also receive a bounded validated summary of the previously generated
objects, so they can share one local coordinate system and avoid duplicates.
Each pass may produce **up to 24 editable primitives**; the combined scene
contains at most **96 primitives** and remains bounded by the normal
document-level limits. Every generated object carries a validated `layer`
field, is grouped under its corresponding Three.js layer, and can be found
with the editor's object-layer filter. Legacy/manual objects without this
field remain compatible with existing timeline JSONs.

This does **not** reproduce unseen surfaces or guarantee survey-accurate
geometry. It is an evidence-led, approximate environment reconstruction
for the **selected chapter**, not automatic alignment of unrelated chapters
into a single global map. Further camera views inside the same chapter
retain the accepted environment instead of generating it again. Nothing
is written to the user's timeline until all passes return valid shapes
and the user explicitly accepts the combined proposal. Failure or discard
keeps previously saved geometry intact; replacing an occupied chapter
requires confirmation. For backups, export timeline JSON first.

**Primary subject only (detail v2):** the editor sends three JPEG reference
frames at 768px width / 0.78 quality where the PHP limits permit, with local
quality/resolution fallback for complex imagery. A single explicit
`primary_subject` mode flag passes through the PHP gateway to the Worker,
where the primary prompt prioritizes the observed main subject (architectural,
technical or macro) and 24–40 meaningful editable subparts when supported by
visible evidence, with a hard cap of **48 primitives** and 9,500 output tokens.
No texture generation, hidden geometry, additional inference calls or model
switching occurs. Legacy one-pass requests retain the previous 36-object cap,
and four-pass Full environment remains unchanged. The 48-object allowance is
not a guarantee of output quality or a requirement to invent unseen detail.

The PHP gateway retains its **10-request-per-session-per-hour** quota.
Full-environment mode consumes **four** authenticated Gemini requests
(versus one for **Primary subject only**), and is limited to Lite and 3.8 Low.
PHP cURL waits up to 55 seconds for these requests and up to 85 seconds for
3.8 Medium Primary; provider runtime and shared-host limits may be stricter.
Paid-tier usage could incur charges. No secrets or raw model outputs are logged.
A pending or failed sequence does not get automatically committed.

### Detailed but still editable AI scenes

The first end-to-end Gemini result was a sparse architectural blockout. The Worker
previously asked for only 16 basic shapes and capped Gemini output at 3,500 tokens.
The improved prompt now analyzes all 3 chronological frames together, budgets at
most **36 editable objects** (typically 18–32 when supported by the images),
and calls for identifiable roof, wall, glazing, entrance, site, machinery and
equipment details. The output cap is now 7,500 tokens. The new temporary
Three.js inspection lights and floor grid make dark materials easier to see
without changing the saved timeline, original authored world or GLB geometry.

These results remain **approximate primitives**, not photogrammetry, textured
meshes or a faithful reconstruction of hidden details. A model may return
fewer than 36 objects when evidence is weak. Gemini output costs/latency can
increase with a longer response if the API project is on a paid tier;
Google's free-tier availability depends on the account and its limits.
Accepting an AI proposal replaces only the selected chapter's primitive scene,
after confirmation if it already has objects. Export timeline JSON before
making major edits to preserve a backup of the original geometry.

- **AI model selector:** The editor defaults to `gemini-3.5-flash-lite` (the known-working, faster model) and offers `gemini-3.8-flash` as an explicit quality experiment in either Primary subject or Full environment. Both use the existing encrypted Worker `GEMINI_API_KEY`. No new API key is required, although your Google project's entitlement, free-tier capacity, API quota and any paid billing determine whether 3.8 is actually available. The browser submits only the allowlisted model ID, which PHP and the Worker validate independently. No raw model URLs, prompt injection or arbitrary provider selection; **no automatic model fallback** after a failure. The editor now exposes three fixed, allowlisted profiles: `lite_default` (3.5 Flash-Lite; default; 45-second Worker / 55-second PHP), `g38_low` (3.8 Flash with `thinkingLevel: low`; 45s/55s), and `g38_medium` (3.8 Flash with `thinkingLevel: medium`; **Primary subject only**; 70s/85s). The PHP gateway and Worker reject unrecognized profiles, mixed `profile`/legacy `model` requests, and medium in any layered environment pass. Older model-only clients remain compatible. Medium keeps the same three frames, 48-object cap and 9,500 output-token budget; the only requested model difference from Low is thinking level. We do not silently switch models after provider errors. The 50webs shared host may impose a stricter execution limit than the 85s PHP cURL timeout; completion is not guaranteed. If Medium continues to timeout, switch back to Low or implement a durable async job/poll service rather than raising synchronous limits further. Before testing a full four-pass run, try Primary subject only (one PHP-counted request).
- `GET /health` reports the public default `model`, `supportedModels` allowlist, and revision alongside `ready`, allowing production to verify the Worker version. This is NOT a Gemini entitlement check or a successful model inference. Do not infer 3.8 Flash works until an authenticated request returns validated primitives.
- Under some free-tier conditions, submitted data may be used for service improvement. **Start with the already-public reference video only**; review Google's current terms before submitting client/private footage.
- Do not paste either secret or your passphrase in GitHub issues, screenshots, PR comments, or this chat.

## Current deployment verification boundary

GitHub CI can test PHP syntax, Worker authorization, JSON validation and packaging. It cannot validate the actual remote `/www/certificates/paiver.php`, the 50webs PHP runtime, or the Cloudflare worker build outcome without access to those services. A successful GitHub Actions FTP transfer does not prove the backend has working credentials.

## 50webs PHP site isolation and protected private config

The temporary diagnostics (now removed) confirmed:

- `scene-proxy.php` and the PHP document root exist and are visible to PHP.
- The file-manager-owned `/www/certificates/paiver.php` and the attempted `/home/www/`, relative ancestor, and document-root ancestor variants are invisible to PHP (no directories or file detected).
- PHP reports `open_basedir` disabled. That does **not** prove all account folders are reachable.

50webs advertises the **JailHost** option for website isolation. If enabled on the `paige-lighthouse.50webs.org` domain, it may prevent PHP from seeing directories outside this domain, including `/www/certificates`. Verify the JailHost setting and directory ownership/permissions in 50webs before inferring the cause conclusively. Do **not** disable website isolation just to reach secrets, make protected files world-writable, or upload secrets into the public editor.

If JailHost is confirmed as the blocker, prefer a separately protected private configuration directory *within the domain's accessible storage*, secured by the host's supported deny-access mechanism and verified with an HTTP 403 direct-access test, before adding an explicit, fixed include path. Host support can recommend a non-HTTP-served directory accessible to the jailed PHP process. Never put real tokens in the GitHub repo, project ZIP, or frontend JavaScript.


## Simpler 50webs private config option: protected folder under editor (requires proof first)

If the non-hosted `/www/certificates/` directory is unavailable to PHP under the domain's jail, a local protected directory can work **only if HTTP requests are blocked at the server**.

This repository automatically uploads **only** these harmless, non-secret files to the public editor's `.private/` directory:

- `.private/.htaccess`: `Require all denied` (Apache 2.4 authorization), plus `ErrorDocument 403 "Forbidden"` to avoid the host's verbose error page revealing its internal filesystem path.
- `.private/deny-check.txt`: harmless constant text to test that the rule is effective.

**Before uploading or moving ANY secrets**, open:
`https://paige-lighthouse.50webs.org/Indium/paiver/.private/deny-check.txt`

- **HTTP 403 Forbidden**: the Apache access-denial rule appears to work. You can cautiously proceed with the configuration file, understanding this is still webroot storage and carries more risk than a genuine non-web-served secrets directory.
- **HTTP 200 with test content**: STOP. The site ignored the deny rule or it is not in effect. Never put secrets in this folder.
- **HTTP 404, 500 or another error**: Do not assume it is protected; investigate whether the denial file was uploaded or server rewrites are interfering. HTTP 404 can indicate either an inaccessible dot-folder or a missing file.

After verifying the server blocks direct access, use the 50webs HTTPS File Manager (NOT the current project's unencrypted FTP connection) to manually create:

`/www/paige-lighthouse.50webs.org/Indium/paiver/.private/paiver.php`

Copy the same contents as the private `docs/paiver.config.example.php` template. The running PHP gateway now tries `__DIR__ . '/.private/paiver.php'` first, then the three earlier candidate locations. Do **not** add this actual secret file to the source repository, generated workspace ZIP, or GitHub Actions. The public website's automated FTP publisher explicitly stages only the guard and harmless check file, not your configuration.

Once installed, verify (1) the test file is still denied by HTTP and (2) a GET on `scene-proxy.php` returns `ok:true` with `authenticated:false`. Directly visiting `.private/paiver.php` must **also** return a server-enforced HTTP 403; PHP's normal "no output" behavior alone is not proof of protection. Keep server backup files (`.bak`, `.old`, `.txt`, editor swap files) out of this directory too.

If 50webs does not honor `.htaccess`, choose another server-supported deny rule or move authentication to Cloudflare Access; do not bypass this check just to make the AI button work.


### Suppressing Apache's verbose shared-host error page

In the live post-deploy test, 50webs continued to return a path-disclosing `AH01630` error page even when the private guard specified `ErrorDocument 403 "Forbidden"`. The access rule *did* block the private file (HTTP 403). The updated guard keeps `Require all denied` but points Apache to a generic document at `/Indium/paiver/private-denied.html` in the site's **public, non-secret** root. The FTP build includes that HTML page. It contains no sensitive data and immediately returns browsers to `/Indium/paiver/` via meta refresh and `location.replace`. The server-side denial must **still** return HTTP 403; the browser navigation is presentation only, not a replacement for access control.

Keep verifying that `.private/deny-check.txt` and `.private/paiver.php` both return HTTP **403**, and that the harmless test's response no longer contains an absolute hosting account path. If the host ignores or blocks this new ErrorDocument, do not remove `Require all denied`; ask the provider about customizing 403 responses while retaining the directory denial.

The live smoke checker classifies PHP startup failures with **fixed labels** (for example, `private-file-not-readable`, `private-config-values-invalid`, and `worker-url-invalid`); it never outputs PHP's raw JSON response because that can include CSRF values.


### Editor-root Apache error page (current approach)

The shared host displayed an internal account filesystem path for HTTP 403 responses even with the `.private` directory's `ErrorDocument 403` set to inline text, internal HTML, or an external URL. The next controlled experiment is to set the 403 mapping in the **public editor-root** `.htaccess`, as is customary for an Apache website:

```apache
ErrorDocument 403 /Indium/paiver/403.html
```

The guard in `public-private-guard/.htaccess` must **still** include:

```apache
Require all denied
ErrorDocument 403 /Indium/paiver/403.html
```

`403.html` contains only a generic “Access denied” message, and returns browser users to the editor. It is safe to load directly because it contains no protected data. The private URL must **never** return HTTP 200 with file contents. The post-deploy smoke test checks that the custom page is available, that the protected file cannot be downloaded, and that the response to the harmless `.private/deny-check.txt` does not contain the account's server path. An upstream 50webs-controlled error handler may still override both `.htaccess` files; in that case, host support must change the error template or its override settings.

### Private configuration values

The PHP gateway now *can* load the manually moved `.private/paiver.php` file, but the production smoke test reported `private-config-values-invalid`. This is a **configuration-value** issue, not a file-read failure. Verify in the 50webs HTTPS file editor:

- The public Worker URL is fixed in `scene-proxy.php`; an old `worker_endpoint` entry in the private config is ignored
- `scene_access_token` is a quoted string of **at least 32 characters**, and matches Cloudflare's runtime `SCENE_ACCESS_TOKEN`.
- `editor_passphrase` is a quoted string of **at least 16 characters**.

Both secret values must be present as PHP array keys, with no placeholders (`PASTE_`, `CHOOSE_`). Do not show these values in screenshots, GitHub issues, or chats.


### Preemptive private-URL redirect experiment

The post-deployment smoke test found that **both** the local `.private` ErrorDocument and the public editor-root ErrorDocument are overridden by 50webs' verbose, path-revealing 403 page. The public `.htaccess` now has a narrowly scoped `mod_rewrite` redirect for `.private` URLs:

```apache
RewriteEngine On
RewriteRule ^\\.private(?:/|$) /Indium/paiver/ [R=302,L,NC]
```

The private directory **still** contains `Require all denied`. The rewrite affects only requests whose relative URL begins with `.private`, and the server never sends private file contents. The smoke test observes the *initial* response without following redirects: only an HTTP 30x with `Location` exactly equal to the public editor URL, or HTTP 403 without internal path disclosure, counts as a safe outcome. HTTP 200 for either the private configuration or harmless probe is always a failure.

If `mod_rewrite` is unavailable or 50webs processes access denial before the editor-root rule, remove the rewrite but **do not remove the independent `Require all denied` rule**. In that case the remaining information disclosure is controlled by the host's error template and may require host support.

The separate PHP integration remains blocked until the two required private values in `.private/paiver.php` pass validation. The runtime token/passphrase lengths are checked without printing any values.


### mod_alias request-translation redirect (last host test)

The earlier root `mod_rewrite` rule still failed to intercept the denied URL before 50webs displayed its server path. This change adds a `mod_alias` `RedirectMatch` at the public editor root:

```apache
RedirectMatch 302 ^/Indium/paiver/\\.private(/|$) /Indium/paiver/
```

This matches only the protected prefix. The prior rewrite and generic 403 ErrorDocument remain fallbacks. The real protection is unchanged: `.private/.htaccess` still contains `Require all denied`.

The automated smoke test will only accept a 302/other approved redirect to the exact editor URL, or a path-free 403. It follows no redirect and reads **no content from paiver.php**. If the host still displays a detailed 403, stop trying more PHP/Apache user-space overrides; 50webs must change its server-level error handling or the site must move to hosting that permits custom error pages. Do not reduce secret-file protection to suppress this error.


### SSH-assisted verification without displaying secrets

If you have shell/SSH access, navigate to the public editor directory and run the following read-only validation. **Do not paste or show the file contents.**

```bash
php -r '$c=require ".private/paiver.php"; foreach (["scene_access_token"=>32,"editor_passphrase"=>16] as $k=>$n) { $v=$c[$k]??null; echo $k, ": ", is_string($v)&&strlen($v)>=$n ? "length-ok" : "missing-or-too-short", PHP_EOL; }'
```

This prints only whether the secret token and passphrase are present with acceptable lengths. Do **not** use `cat` or post screenshots of your configuration; keep all secret values off the command line. Because the Worker URL is no longer read from the private file, a mistyped `worker_endpoint` entry cannot break PHP startup.
