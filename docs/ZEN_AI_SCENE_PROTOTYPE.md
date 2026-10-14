# Phase 3 proof-of-concept — private OpenCode Zen scene analysis

**Status:** Initial integration, limited to one existing reference-video shot at a time. It creates an editable primitive proposal but **does not automatically replace editor scenes, recover exact geometry, or generate camera paths**.

## Secret

The GitHub repository Actions secret is called `zen_api`. It is read ONLY in the private GitHub Actions runner as `ZEN_API_KEY`. Never write this key into `app.js`, FTP assets, Git, an exported timeline, browser localStorage, PR comments, or CI logs. The static website cannot access repository Actions secrets.

## First test / manually generate scenes

Open [Zen AI scene proposal workflow](https://github.com/Teethree89/paige-video-render/actions/workflows/ai-scene-zen.yml), choose **Run workflow**.

- **shot_id:** `hall` (initial benchmark), or another shot id from root `timeline.json` such as `pcb`, `laser`, or `finale`.
- **model:** `muse-spark-1.3-contributor-free` (the only allowlisted model, listed free in the current OpenCode Zen catalog).

GitHub Actions reconstructs the bundled reference MP4, samples **three frames inside the selected shot**, and sends those frames to Zen's documented Responses endpoint. The model receives spatial-layout instructions and is asked to produce 0–16 allowed primitive objects. Its response is checked against the same `primitive-schema.js` validator as the editor. On success the workflow uploads the `zen-primitive-proposal-<run-id>` artifact containing `hall-primitives.json`.

In the editor, load the original timeline (or a compatible timeline with matching shot IDs), select **3D Primitive Scene Editor → Import JSON**, and choose the downloaded `hall-primitives.json`. This replaces the **primitive scenes** in the current working timeline after confirmation, not the original camera/text timeline or the GitHub default. Export the full timeline to keep the results. The editor does not ingest ZIP artifacts directly: unzip the artifact first.

**Visual comparison note:** Existing original `hall` geometry also renders during `hall`, so imported primitive geometry may visually overlap the hand-authored scene. For a clean standalone comparison we will add scene-source switching in a later iteration. The first proof-of-concept is intended to verify model input, object recognition, schema compliance, and editable geometry handoff.

## Cost and privacy

OpenCode lists Muse Spark 1.3 Contributor Free with free token prices at the time of implementation. Provider availability and terms may change. This specific variant may have different data-use/retention terms from standard paid models; confirm the current terms before sending *non-public or client-owned* media. The initial test uses only frames from the **already-public sample video** in this repository.

The workflow allows this one **free** model ID only, to avoid accidentally running a paid fallback. Do not change it to a paid model without an explicit decision. It runs manually, with one first-time smoke test when this workflow file is merged onto `main`; ordinary pushes do not repeatedly call Zen.

## Why the website button is not directly connected yet

The deployed FTP site is static; it cannot securely read `zen_api` from GitHub. Sending OpenCode requests straight from client JS would expose the credential. The first integration uses GitHub Actions and download/import, not direct one-click requests. To support arbitrary videos imported in the browser, a future task can create an authenticated API/upload service that keeps the key on the server, handles media retention, and returns proposal JSON to the editor.

## Validation and failure modes

The unit tests do not contact Zen. The first live run will establish whether the account authorizes Muse Contributor Free *and* whether Zen's gateway accepts `input_image` entries. If it fails, inspect the Actions step for HTTP status (without raw response or secrets), and check provider documentation/permissions. No invalid model output will be committed or automatically applied.

Implementation:
- `scripts/zen_scene.py`: video frame extraction, sanitized Responses API call, JSON decoding.
- `scripts/validate_zen_scene.mjs`: exact existing JavaScript schema validation.
- `tests/test_zen_scene.py`: offline regression tests.
- `.github/workflows/ai-scene-zen.yml`: private manual workflow + first-time smoke test.
