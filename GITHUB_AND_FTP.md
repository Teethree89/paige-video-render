# GitHub to FTP — workspace publishing

The repository publishes the browser-viewable Three.js editor and a complete downloadable workspace archive whenever `main` changes or the workflow is started manually.

## FTP connection settings

The workflow pins the FTP username to `paiver_paige-lighthouse.50webs.org` and the host to `paige-lighthouse.50webs.org` on port 21, matching the provided FileZilla XML. Only the password is read from GitHub Actions secrets, using the same `FTP_PASS` secret name as Grasstex if available, otherwise `FTP_PASSWORD`. Set it under **Settings → Secrets and variables → Actions → Repository secrets**.

| Secret | Value |
|---|---|
| `FTP_PASS` (preferred) or `FTP_PASSWORD` | Password for this repository's `paiver` FTP account (never commit it). `FTP_PASS` takes precedence if both exist. |

The workflow uses the same `lftp -u user,password host` command and disabled TLS setting as the proven [Grasstex production deploy](https://github.com/APPARANYX/grasstex/blob/main/.github/workflows/deploy-50webs-php.yml). It uses the same host as the FileZilla screenshot: `paige-lighthouse.50webs.org` on port 21. Existing `FTP_HOST` and `FTP_USER` secrets can remain, but they are not used. No `FTP_REMOTE_DIR`, `FTP_KNOWN_HOSTS`, or `FTP_PROTOCOL` setting is needed.

**Destination:** The FTP account is reported to start in the web directory `/www/paige-lighthouse.50webs.org/Indium/paiver`. The deployment uses relative `.` as its destination. It does **not** send that server filesystem path as a remote FTP path, since the FTP account already starts there.

## What is published

Each push to `main` runs **Actions → Publish workspace via FTP**:

1. Validate the source and asset integrity.
2. Build the complete workspace, including editable models, camera/text timeline, After Effects handoff, and MP4 draft.
3. Save the full ZIP as a GitHub Actions artifact, retained for 14 days.
4. If the FTP username and password secrets exist, upload the browser editor files, `assets/`, and `downloads/paige-video-render-workspace.zip` directly into the FTP login directory.

The upload deliberately **does not delete existing remote files**. It *does* update files with matching names, including `index.html`. Confirm that this directory is intended to serve the editor before running the first deployment; any existing `index.html` could be replaced.

The editor is `index.html`, the browser video export tool is `render.html`, and the complete workspace is `downloads/paige-video-render-workspace.zip`. Public browser URLs depend on the web host mapping.

## Plain FTP security note

As requested, deployment now uses **unencrypted standard FTP** over port 21 to `paige-lighthouse.50webs.org`. This sends your FTP credentials and uploaded file data across the network without transport encryption. GitHub secrets are not written to the repository or ZIP, but GitHub Secrets do not encrypt the FTP connection itself. The working Grasstex command also supplies credentials via process arguments; never enable shell tracing in the deployment script. If secure FTPS can be configured later, that is the recommended long-term deployment transport.

There is no SFTP/SSH connection here; `FTP_KNOWN_HOSTS` is not relevant.

## Manual publish

Open **GitHub → Actions → Publish workspace via FTP → Run workflow**. It also runs automatically with each `main` push.

The source project itself loads its pinned Three.js dependencies from an external CDN when opened in a browser. Keep your FTP password in GitHub Secrets only.

## Authentication failures

If 50webs reports `530 Login authentication failed` even after the matched `lftp -u` command, then the network connection was established but the server rejected the username/password pair. Verify the `paiver` account's **own** FTP password in FileZilla, then set it as `FTP_PASS` in **this repository**. GitHub Actions secrets are repository-specific and cannot be read across projects. The similarly named `paigegroup` account is a separate account and should not be used for Paige's `paiver` folder.
