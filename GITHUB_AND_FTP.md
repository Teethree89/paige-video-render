# GitHub + FTP workspace publishing

The repo holds the full editable flythrough: source JS/CSS/HTML, the camera & text timeline, seven linked GLBs, a small reference video, the MP4 draft render, and the After Effects `.jsx` builder. **Raw original 132MB footage is intentionally excluded**, since the project does not require it to operate.

## Local development

```bash
python3 scripts/reconstruct_media.py && python3 -m http.server 8000
# open http://localhost:8000
```

After changing GLBs or the sequence, commit `assets/models/*.glb`, `assets/models/manifest.json`, and/or `timeline.json` to GitHub. `git push origin main` triggers both validation and export publishing.

## Actions

- **Validate workspace**: tests JS syntax, JSON timeline, GLB integrity, and creates a downloadable workspace ZIP artifact on push/PR/manual run.
- **Publish workspace via SFTP / FTPS**: runs on every `main` push (or manual dispatch), builds a comprehensive `dist/` folder and an archive at `dist/downloads/paige-video-render-workspace.zip`; uploads all files to the isolated `${FTP_REMOTE_DIR}/current/` directory **only when credentials are configured**. Earlier GitHub workflow artifacts remain downloadable for 14 days.

The entire rendered/editor site is browsable from the `/current/index.html` path on your host when the FTP account maps to a publicly served web directory. The archive is downloadable at `/current/downloads/paige-video-render-workspace.zip`. FTP itself is an upload protocol; publishing a public URL requires a web host mapped to the destination.

### Repository settings

Under **Settings → Secrets and variables → Actions**, set these **secrets**:

| Secret | Value |
| --- | --- |
| `FTP_HOST` | FTP/SFTP server hostname (no scheme) |
| `FTP_USER` | Deployment account |
| `FTP_PASSWORD` | Deployment password or SFTP password |
| `FTP_REMOTE_DIR` | Dedicated absolute directory, e.g. `/paige-video-render` |
| `FTP_PORT` | Optional: `22` for SFTP / `21` for FTPS |
| `FTP_KNOWN_HOSTS` | **Required for SFTP:** verified OpenSSH known_hosts entry for your host (or `[host]:port` for nonstandard ports) |

Under **Variables** (not Secrets), set `FTP_PROTOCOL=sftp` (default) or `FTP_PROTOCOL=ftps`. **Unencrypted FTP is deliberately not supported.** FTPS uses certificate verification. SFTP checks the server's host key against `FTP_KNOWN_HOSTS` and fails closed if missing.

Verify the correct SSH fingerprint with your hosting provider before saving a known_hosts line. You can collect a candidate with `ssh-keyscan -p 22 example.your-host.com` and compare its fingerprint to the provider's separately published fingerprint. Do not blindly trust unauthenticated scan output.

### Security and synchronization

GitHub secrets are never written into the repo or ZIP. The deploy script rejects remote `/` and path traversal, always scopes upload to `${FTP_REMOTE_DIR}/current/`, then synchronizes with `--delete` inside that `current` folder, ensuring removed workspace files do not linger. **Use a dedicated folder because anything else already inside `current/` is removed on publish.** The `main` branch history preserves previous workspace versions.

### Manual publish

GitHub → **Actions** → **Publish workspace via SFTP / FTPS** → **Run workflow**. If the secrets are missing, the workflow still builds and uploads the ZIP as a GitHub artifact but skips the remote upload.

## AE / video output

The MP4 at `exports/flythrough-preview.mp4` is a draft. `render.html` records the original WebGL renderer through the browser export flow, then `.sh` / `.bat` converts WebM to MP4 with FFmpeg as necessary. Run `AfterEffects/BUILD_EDITABLE_PROJECT.jsx` in After Effects to create an editable composition. Three.js rendering effects are not identical in native AE.

### Preview media tracking

The 6.8MB draft MP4 is stored as seven checksum-verified 1MB chunks under `exports/media-parts/` due to GitHub API upload limits. Run `python3 scripts/reconstruct_media.py` to restore `exports/flythrough-preview.mp4`. GitHub Actions restores it automatically before creating the complete export ZIP. FTP exports include `.github/`, `scripts/`, `tests/`, docs, and the restored MP4.
