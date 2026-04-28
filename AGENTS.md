<!-- SPECKIT START -->
# General Instructions

- after every change to the source code make sure the Agent.md file is updated
- after every new feature added, make sure there is a test for the feature (no tests for removing features)
- after changing the code, start a new dev server and ask the user to check the resulting app functionality

## Development

- **Start dev server**: `cd web && bash run.sh` (serves on http://localhost:8080)
- **Setup**: `cd web && bash setup.sh` (downloads ONNX Runtime WASM files)

## Linting

Run `npm run lint` before committing JS changes. This parses all `web/**/*.js` files for syntax errors using acorn. The same check runs in CI before deploy.

Common issues it catches:
- `await` in non-async functions
- Mismatched brackets/parens
- Invalid ES module syntax

## Architecture

- `web/js/spinalcordtoolbox-app.js` — Main app class, orchestrates everything
- `web/js/app/config.js` — Model config, version (bumped automatically by CI)
- `web/js/app/sct-tasks.js` — SCT stable task inventory and task status helpers
- `web/js/app/labels.js` — Task labels + NiiVue colormap
- `web/js/inference-worker.js` — Web Worker running the 3D inference pipeline (~700 lines, uses `importScripts`, not ES modules)
- `web/js/controllers/` — FileIO, DICOM, Inference, Viewer controllers
- `web/js/modules/` — UI components and inference pipeline modules

## Key Conventions

- The inference worker uses `importScripts()` (no ES modules)
- Config version is bumped automatically by the GitHub Actions release workflow via `sed` — do not bump manually
- Keep model availability metadata internal; user-facing UI copy should describe runnable tasks without release/support commentary.
- Run `python scripts/validate_sct_models.py --manifest web/models/manifest.json --all-tasks` after SCT manifest changes

## CI/CD

- **Release workflow** (`.github/workflows/release.yml`): triggers on push to main, auto-bumps version, creates tag + GitHub release
- **Deploy workflow** (`.github/workflows/deploy-pages.yml`): triggers after release, runs JS syntax lint, downloads ONNX Runtime WASM files, deploys to GitHub Pages

<!-- SPECKIT END -->
