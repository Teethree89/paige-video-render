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
    'worker_endpoint' => 'https://YOUR_WORKER_SUBDOMAIN.workers.dev/api/scene',
    'scene_access_token' => 'PASTE_THE_SAME_SCENE_ACCESS_TOKEN_HERE',
    'editor_passphrase' => 'CHOOSE_YOUR_OWN_UNIQUE_PASSPHRASE_HERE',
];
```

Replace the URL with the *actual* public Worker hostname from Cloudflare → Domains & Routes, followed by `/api/scene`. The URL is not a credential. Replace the token placeholder with exactly the long token bound to `SCENE_ACCESS_TOKEN` in Cloudflare. Choose a new, unique **memorable passphrase of 16+ characters**, not your FTP password, Cloudflare password, or other existing secret. The short sign-in interface asks for this passphrase once per PHP session. The private PHP file is deliberately server-only and contains plaintext secrets; ensure it is not HTTP accessible and use restrictive filesystem permissions such as `0600` when supported by the host.

**You must create that private file manually.** The repository/FTP publishing job cannot and must not upload it.

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
- The fixed model is `gemini-2.5-flash-lite`; **no paid model fallback** is coded. Free API availability and rate limits depend on the account/region and can change.
- Under some free-tier conditions, submitted data may be used for service improvement. **Start with the already-public reference video only**; review Google's current terms before submitting client/private footage.
- Do not paste either secret or your passphrase in GitHub issues, screenshots, PR comments, or this chat.

## Current deployment verification boundary

GitHub CI can test PHP syntax, Worker authorization, JSON validation and packaging. It cannot validate the actual remote `/www/certificates/paiver.php`, the 50webs PHP runtime, or the Cloudflare worker build outcome without access to those services. A successful GitHub Actions FTP transfer does not prove the backend has working credentials.
