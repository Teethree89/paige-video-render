<?php
/**
 * COPY THIS TEMPLATE ONLY to the non-hosted server path:
 *     /www/certificates/paiver.php
 *
 * Do not upload the real values to GitHub, the public website, the ZIP export,
 * or any folder downloadable over HTTP.
 */
return [
    // From Cloudflare dashboard → Workers → paige-video-render → Domains & Routes.
    // Use the actual workers.dev HTTPS hostname, ending in /api/scene.
    'worker_endpoint' => 'https://YOUR_WORKER_SUBDOMAIN.workers.dev/api/scene',

    // Exactly the same long token configured in the Cloudflare Worker
    // secret SCENE_ACCESS_TOKEN. It must never appear in browser JS.
    'scene_access_token' => 'PASTE_THE_SAME_SCENE_ACCESS_TOKEN_HERE',

    // Choose your OWN strong, memorable passphrase (at least 16 characters).
    // This authorizes editor sessions; it is NOT the Cloudflare Worker token.
    // Treat this as a secret. Do not use a regular site/FTP password.
    'editor_passphrase' => 'CHOOSE_YOUR_OWN_UNIQUE_PASSPHRASE_HERE',
];
