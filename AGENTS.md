<!-- SPECKIT START -->
# General Instructions

- after every change to the source code make sure the Agent.md file is updated
- after every new feature added, make sure there is a test for the feature (no tests for removing features)
- after changing the code, start a new dev server and ask the user to check the resulting app functionality

## Development

- **Start dev server**: `cd web && bash run.sh` (serves on http://localhost:8080)
- `web/run.sh` stops an existing SCT dev server on the requested port before starting a replacement; use an alternate port argument when another non-SCT process owns `8080`
- **Setup**: `cd web && bash setup.sh` (downloads ONNX Runtime WASM files)

## Linting

Run `npm run lint` before committing JS changes. This parses all `web/**/*.js` files for syntax errors using acorn. The same check runs in CI before deploy.

Common issues it catches:
- `await` in non-async functions
- Mismatched brackets/parens
- Invalid ES module syntax

## Architecture

- `web/js/spinalcordtoolbox-app.js` — Main app class, orchestrates everything
- `web/js/app/config.js` — Model config, version (bumped by the manual release workflow)
- `web/js/app/sct-tasks.js` — SCT stable task inventory and task status helpers
- `web/js/app/labels.js` — Task labels + NiiVue colormap
- `web/js/inference-worker.js` — Web Worker running the 3D inference pipeline (~700 lines, uses `importScripts`, not ES modules)
- `web/js/controllers/` — FileIO, DICOM, Inference, Viewer controllers
- `web/js/modules/` — UI components and inference pipeline modules

## Key Conventions

- The inference worker uses `importScripts()` (no ES modules)
- `ViewerController` owns NiiVue overlay lifecycle; keep segmentation as one managed overlay volume, and use segmentation-as-base mode when the input volume is hidden because NiiVue volume 0 is not a reliable hide target.
- Route input/segmentation visibility changes through `renderViewerVolumes()` so the Results eye buttons and toolbar input toggle rebuild a consistent NiiVue volume stack.
- Config version is bumped by the manual GitHub Actions release workflow via `sed`; it increments the patch version — do not bump manually
- Keep model availability metadata internal; user-facing UI copy should describe runnable tasks without release/support commentary.
- SCT Processing controls should not include explanatory copy about synthetic validation fixtures or generated task metadata.
- Run `python scripts/validate_sct_models.py --manifest web/models/manifest.json --all-tasks` after SCT manifest changes
- Gray matter (`graymatter`) uses a 2D nnU-Net wrapper; keep its manifest preprocessing (`modelAxisOrder`) in sync with worker-level fixture parity against `test_data/batch_t2s_deepseg_graymatter`.

## CI/CD

- **Release workflow** (`.github/workflows/release.yml`): manual-only promotion; bumps version, creates tag + GitHub release
- **Deploy workflow** (`.github/workflows/deploy-pages.yml`): deploys staging from `main` on push, deploys production from the latest release tag, runs JS syntax lint, downloads ONNX Runtime WASM files, deploys to GitHub Pages
- GitHub Pages deploys must check out Git LFS assets and verify `web/models/*.onnx` are real model binaries, not LFS pointer files

<!-- SPECKIT END -->
