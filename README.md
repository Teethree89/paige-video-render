# Paige — Atoms to AI Three.js flythrough

Editable 56.47-second Three.js camera flythrough with seven externally editable GLB scene assets, 27 camera keys, timed text overlays, browser video export and an Adobe After Effects JSX project builder.

## Use locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. This is a static ES-module site and uses the pinned Three.js CDN.

## Production handoff

- `assets/models/*.glb`: editable models (keep filenames and transforms for camera continuity).
- `assets/models/manifest.json`: model links and transforms.
- `timeline.json`: camera/text/shot keyframes.
- `render.html`: browser video export (MP4 where available; otherwise WebM).
- `AfterEffects/BUILD_EDITABLE_PROJECT.jsx`: editable AE composition builder.
- `exports/flythrough-preview.mp4`: reference output (offline draft).

## Workspace publishing

Each push to `main` validates the project and creates a ZIP artifact; when secrets are configured, GitHub Actions also synchronizes the workspace over secure **SFTP** or **FTPS**.

See [GITHUB_AND_FTP.md](GITHUB_AND_FTP.md) for setup and safety details. Deployment credentials must never be committed to the repository.

Note: the 132 MB original source video is not stored in git. The app bundles a much smaller silent reference video.
