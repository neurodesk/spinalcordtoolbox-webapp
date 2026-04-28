<!-- SPECKIT START -->
# Agent Instructions

## Project Overview

spinalcordtoolbox is a browser-based spinal cord MRI segmentation app targeting Spinal Cord Toolbox stable model workflows. Patient image data stays confidential and browser-local; non-patient usage telemetry may be collected. SCT task support is manifest-driven via `web/models/manifest.json`; do not mark tasks supported until browser-runnable assets are converted and validated. See README.md for full details.


## Development

- **Start dev server**: `cd web && bash run.sh` (serves on http://localhost:8080)
- **Setup**: `cd web && bash setup.sh` (downloads ONNX Runtime WASM files, builds Rust preprocessing)

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
- `rust-preprocessing/` — Rust WASM crate (N4ITK bias correction, NLM denoising, BET)

## Key Conventions

- The inference worker uses `importScripts()` (no ES modules) — built with `wasm-pack --target no-modules`
- Config version is bumped automatically by the GitHub Actions release workflow via `sed` — do not bump manually
- WASM preprocessing is optional; the app works without it (skips bias correction/denoising)
- Default target spacing: 0.3mm isotropic
- Run `python scripts/validate_sct_models.py --manifest web/models/manifest.json --all-tasks` after SCT manifest changes

## CI/CD

- **Release workflow** (`.github/workflows/release.yml`): triggers on push to main, auto-bumps version, creates tag + GitHub release
- **Deploy workflow** (`.github/workflows/deploy-pages.yml`): triggers after release, runs JS syntax lint, builds WASM, deploys to GitHub Pages

<!-- SPECKIT END -->
