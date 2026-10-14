# Phase 3 proof-of-concept — private OpenCode Zen scene analysis

## Live connection status (October 14, 2026)

**BLOCKED by the free model provider.** The repository's `zen_api` secret is present in Actions and can be read by the job, and our parser/schema/unit tests pass. The initial raw Zen Responses API request to `muse-spark-1.3-contributor-free` returned **HTTP 403**. A second request via the official OpenCode CLI also failed; sanitized diagnostics classified the response as `FREE_TIER_CLIENT_RESTRICTION`. See [raw API run](https://github.com/Teethree89/paige-video-render/actions/runs/38614893027), [official CLI run](https://github.com/Teethree89/paige-video-render/actions/runs/38615636453), and [diagnostic run](https://github.com/Teethree89/paige-video-render/actions/runs/38616081643).

This does **not** indicate a missing GitHub secret or a broken primitive scene schema. OpenCode has free-tier restrictions beyond whether a model appears in its catalog; similar `FreeTierError` reports exist for Muse. Do not bypass those restrictions by spoofing client identity or headers. Do not switch to a paid model without explicit user approval.

The GitHub workflow is retained as an **experimental manual test**, not a functional production generator. No AI proposal JSON was produced. Existing editable primitives, hand-authored scenes, and FTP publishing remain functional. To unblock AI, use an explicitly permitted model/API plan, or an alternative provider with a documented free vision endpoint and separate secret.

**Status:** Initial integration, limited to one existing reference-video shot at a time. It creates an editable primitive proposal but **does not automatically replace editor scenes, recover exact geometry, or generate camera paths**.

## Secret

The GitHub repository Actions secret is called `zen_api`. It is read ONLY in the private GitHub Actions runner as `ZEN_API_KEY`. Never write this key into `app.js`, FTP assets, Git, an exported timeline, browser localStorage, PR comments, or CI logs. The static website cannot access repository Actions secrets.

## First test / manually generate scenes

Open [Zen AI scene proposal workflow](https://github.com/Teethree89/paige-video-render/actions/workflows/ai-scene-zen.yml), choose **Run workflow**.

- **shot_id:** `hall` (initial benchmark), or another shot id from root `timeline.json` such as `pcb`, `laser`, or `finale`.
- **model:** `muse-spark-1.3-contributor-free` (the only allowlisted model, listed free in the current OpenCode Zen catalog).

GitHub Actions reconstructs the bundled reference MP4, samples **three frames inside the selected shot**, and attaches those frames to the **official OpenCode CLI** running noninteractively with the built-in Zen provider. The script uses the `zen_api` secret via environment-variable substitution. The model receives spatial-layout instructions and is asked to produce 0–16 allowed primitive objects. Its response is checked against the same `primitive-schema.js` validator as the editor. On success the workflow uploads the `zen-primitive-proposal-<run-id>` artifact containing `hall-primitives.json`.

In the editor, load the original timeline (or a compatible timeline with matching shot IDs), select **3D Primitive Scene Editor → Import JSON**, and choose the downloaded `hall-primitives.json`. This replaces the **primitive scenes** in the current working timeline after confirmation, not the original camera/text timeline or the GitHub default. Export the full timeline to keep the results. The editor does not ingest ZIP artifacts directly: unzip the artifact first.

**Visual comparison note:** Existing original `hall` geometry also renders during `hall`, so imported primitive geometry may visually overlap the hand-authored scene. For a clean standalone comparison we will add scene-source switching in a later iteration. The first proof-of-concept is intended to verify model input, object recognition, schema compliance, and editable geometry handoff.

## Cost and privacy

OpenCode lists Muse Spark 1.3 Contributor Free with free token prices at the time of implementation. Provider availability and terms may change. This specific variant may have different data-use/retention terms from standard paid models; confirm the current terms before sending *non-public or client-owned* media. The initial test uses only frames from the **already-public sample video** in this repository.

The workflow allows this one **free** model ID only, to avoid accidentally running a paid fallback. Do not change it to a paid model without an explicit decision. It runs manually, with one first-time smoke test when this workflow file is merged onto `main`; ordinary pushes do not repeatedly call Zen.

## Why the website button is not directly connected yet

The deployed FTP site is static; it cannot securely read `zen_api` from GitHub. Sending OpenCode requests straight from client JS would expose the credential. The first integration uses GitHub Actions and download/import, not direct one-click requests. To support arbitrary videos imported in the browser, a future task can create an authenticated API/upload service that keeps the key on the server, handles media retention, and returns proposal JSON to the editor.

## Validation and failure modes

The offline unit tests do not contact Zen. The first live `urllib` Responses API test returned HTTP 403 even though GitHub had access to `zen_api`. OpenCode restricts some free variants when called outside its official client, so a follow-up test uses the supported `opencode run --standalone --model opencode/muse-spark-1.3-contributor-free --file ...` interface rather than impersonating client headers. The CLI trial still needs live confirmation of model access and image support. If it fails, inspect the Actions step for HTTP status (without raw response or secrets), and check provider documentation/permissions. No invalid model output will be committed or automatically applied.

Implementation:
- `scripts/zen_scene.py`: reusable video frame extraction and strict response schema (direct API remains diagnostic-only for free models).
- `scripts/zen_cli_scene.py`: first-party OpenCode CLI adapter and JSON event decoding; avoids the 403 raw-client restriction without header spoofing.
- `scripts/validate_zen_scene.mjs`: exact existing JavaScript schema validation.
- `tests/test_zen_scene.py`: offline regression tests.
- `.github/workflows/ai-scene-zen.yml`: private manual workflow + first-time smoke test.
