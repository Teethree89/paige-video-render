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
