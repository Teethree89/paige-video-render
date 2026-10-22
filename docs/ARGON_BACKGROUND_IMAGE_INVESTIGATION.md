# Argon background image rejection — 2026-10-22

## Evidence and conclusion

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
2. Analyze the same 1–3 ordered JPEG frames in one synchronous Argon interaction
   (`background:false`, `store:false`, low thinking, 4,096 tokens). Preserve the
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

Neither step retries or changes models. The two calls share a 40-second deadline
under the unchanged PHP 45-second transport budget, with a 30-second analysis
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
The old diagnostic stages 6–7 intentionally retain the direct provider probe;
they are not prerequisites for this workaround and should not be replayed.

Deployment requires both the PHP/frontend and Worker changes. Check the safe
Worker revision `argon-workerd-redirect-manual-v1`. No deployment, key,
billing, retention-setting, or private-media changes are part of this PR.
