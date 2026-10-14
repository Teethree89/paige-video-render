# GitHub to FTP — workspace publishing

The repository publishes the browser-viewable Three.js editor and a complete downloadable workspace archive whenever `main` changes or the workflow is started manually.

## Only three GitHub repository secrets are required

Go to **Settings → Secrets and variables → Actions → Repository secrets**.

| Secret | Value |
|---|---|
| `FTP_HOST` | `paige-lighthouse.50webs.org` |
| `FTP_USER` | `paiver_paige-lighthouse.50webs.org` |
| `FTP_PASSWORD` | Your FTP account password (do not commit it) |

There is no `FTP_REMOTE_DIR`, `FTP_KNOWN_HOSTS`, `FTP_PORT`, or `FTP_PROTOCOL` setting. The port is fixed to 21.

**Destination:** The FTP account is reported to start in the web directory `/www/paige-lighthouse.50webs.org/Indium/paiver`. The deployment uses relative `.` as its destination. It does **not** send that server filesystem path as a remote FTP path, since the FTP account already starts there.

## What is published

Each push to `main` runs **Actions → Publish workspace via FTPS**:

1. Validate the source and asset integrity.
2. Build the complete workspace, including editable models, camera/text timeline, After Effects handoff, and MP4 draft.
3. Save the full ZIP as a GitHub Actions artifact, retained for 14 days.
4. If the three credentials exist, upload the browser editor files, `assets/`, and `downloads/paige-video-render-workspace.zip` directly into the FTP login directory.

The upload deliberately **does not delete existing remote files**. It *does* update files with matching names, including `index.html`. Confirm that this directory is intended to serve the editor before running the first deployment; any existing `index.html` could be replaced.

The editor is `index.html`, the browser video export tool is `render.html`, and the complete workspace is `downloads/paige-video-render-workspace.zip`. Public browser URLs depend on the web host mapping.

## FTP encryption and compatibility

The FileZilla XML contains an FTP login on port 21, but it does not prove the host supports encrypted transfers. This workflow requires **explicit FTP over TLS (FTPS)** on port 21, verifying its TLS certificate to protect both your password and the uploaded files. There is no plaintext FTP fallback.

If the host refuses TLS, the workflow will report a failed upload while the GitHub Actions ZIP artifact remains available. Verify FTPS support with your hosting provider. Do not weaken certificate verification or silently transmit credentials via unencrypted FTP.

There is no SFTP/SSH connection here; `FTP_KNOWN_HOSTS` is not relevant.

## Manual publish

Open **GitHub → Actions → Publish workspace via FTPS → Run workflow**. It also runs automatically with each `main` push.

The source project itself loads its pinned Three.js dependencies from an external CDN when opened in a browser. Keep your FTP password in GitHub Secrets only.
