# Implementation Plan: 3-PR Rollout

The work is split into three reviewable PRs. Each PR is shippable
independently — earlier PRs do not surface user-visible features, but they
land tested code that PR 3 then wires up.

## PR 1 — Algorithmic core + asset pipeline

**Goal:** land all the deterministic, well-understood pieces of the algorithm
as pure-JS modules with unit tests. No UI changes, no end-to-end pipeline,
no parity gate yet.

### New JS modules under `web/js/modules/vertebrae/`

| Module | What it does | SCT reference |
| --- | --- | --- |
| `mutual-information.js` | 16-bin 2D histogram + joint entropy MI | [math.py:246-260](https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/spinalcordtoolbox/math.py#L246) |
| `template-matcher.js` | `compute_corr_3d` port: scores Z candidates by MI, returns peak | [core.py:338-459](https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/spinalcordtoolbox/vertebrae/core.py#L338) |
| `disc-propagator.js` | Iterative disc-search loop with adaptive distance correction | [core.py:147-230](https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/spinalcordtoolbox/vertebrae/core.py#L147) |
| `label-segmentation.js` | Relabels each cord voxel by nearest disc above; emits sparse disc image | [core.py:462-520](https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/spinalcordtoolbox/vertebrae/core.py#L462) |
| `gaussian-smooth.js` | Separable 3D Gaussian, sigma=[3,1,1] default | [core.py:80](https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/spinalcordtoolbox/vertebrae/core.py#L80) |
| `centerline-distance.js` | Extracts inter-disc distances from PAM50 levels at centerline | [core.py:93-112](https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/spinalcordtoolbox/vertebrae/core.py#L93) |
| `template-loader.js` | Async loader for PAM50 NIfTI assets, cached in `localforage` | (new) |
| `index.js` | Top-level `labelVertebrae()` orchestrator — **stub in PR 1**, real in PR 3 | (new) |

### Manifest

[`web/models/manifest.json`](../../web/models/manifest.json) gains:

```json
{
  "id": "vertebrae",
  "supportStatus": "unsupported",
  "validationStatus": "unvalidated",
  "templateAssets": [
    { "id": "pam50-t2", "filename": "templates/PAM50/PAM50_t2.nii.gz", "contrast": "T2" },
    { "id": "pam50-levels", "filename": "templates/PAM50/PAM50_levels.nii.gz" }
  ],
  "modelAssets": []
}
```

`unsupported` is intentional — UI gating in
[sct-tasks.js:isTaskRunnable](../../web/js/app/sct-tasks.js) hides unsupported
tasks, so nothing surfaces in the UI yet. PR 3 flips this to `supported`.

### Asset bundling

- New directory `web/models/templates/PAM50/` with `PAM50_t2.nii.gz`,
  `PAM50_levels.nii.gz`, `info_label.txt`. Source from `.tmp_sct_models/` if
  present, or extend `web/setup.sh` to fetch.
- Track via Git LFS like the existing ONNX files.
- Extend the deploy workflow's binary-verification step to cover these files.

### Tests (under `scripts/`)

- `test_vertebrae_mutual_info.mjs` — cross-validate vs sklearn reference values
  (commit a small JSON of `{a, b, expectedMI}`).
- `test_vertebrae_template_matcher.mjs` — synthetic 3D volumes with a Gaussian
  "disc" at known Z; assert detection within ±1.
- `test_vertebrae_disc_propagator.mjs` — synthetic centerline + known disc
  spacings; assert label assignments and adaptive-distance behavior.
- `test_vertebrae_label_segmentation.mjs` — synthetic binary cord + known disc
  list; assert per-voxel labeling matches a hand-computed expected volume.
- `test_vertebrae_gaussian_smooth.mjs` — compare against `scipy.ndimage.gaussian_filter`
  reference values committed as JSON.

### `package.json`

Add:

```
"test:vertebrae": "node --no-warnings scripts/test_vertebrae_mutual_info.mjs && \
                   node --no-warnings scripts/test_vertebrae_template_matcher.mjs && \
                   node --no-warnings scripts/test_vertebrae_disc_propagator.mjs && \
                   node --no-warnings scripts/test_vertebrae_label_segmentation.mjs && \
                   node --no-warnings scripts/test_vertebrae_gaussian_smooth.mjs"
```

Chain into `test:fast`.

### Verification

1. `npm run test:vertebrae` passes.
2. `npm run test:fast` passes (verify [validate_sct_models.py](../../scripts/validate_sct_models.py)
   and [test_batch_processing_cases.cjs](../../scripts/test_batch_processing_cases.cjs)
   tolerate the new manifest entry).
3. `web/setup.sh` fetches PAM50 in CI; deploy workflow verifies real binaries.
4. Webapp loads in dev server with no errors (smoke).

---

## PR 2 — C2-C3 disc detector

This is the hard part. Two paths; **decide at kickoff with a 1-day spike**.

### Path A: train a CNN replacement (recommended)

- Train a small disc-localization model on SCT's own dataset.
- Input: 7-slice mid-sagittal average of T2 anatomy (matches SCT preprocessing).
- Output: 2D heatmap of disc-likelihood. Peak gives 2D disc location.
- Lift to 3D using cord-segmentation centerline R-L coordinate.
- Export to ONNX, ship as `web/models/sct-c2c3-detector.onnx`, integrate into
  worker via existing ONNX Runtime.

### Path B: port the OpenCV HOG+SVM YAML (fallback)

- Vendor a JS HOG implementation.
- Parse the YAML SVM weights.
- Reproduce the sliding window and NMS exactly.
- Brittle and slow but ships no new ML training pipeline.

### Tests

- Synthetic mid-slice with a Gaussian "disc" at known position; assert detector
  returns within ±2 voxels.
- Real-data test: run on `test_data/batch_t2_label_vertebrae/input.nii.gz`,
  assert detected C2-C3 Z is within ±3 slices of SCT's reference (extracted
  from `batch_output.nii.gz` by finding the Z range of label 11→10 transition).

### Verification

- C2-C3 detector test passes against the real fixture.
- No end-to-end pipeline yet; no `browser_output.nii.gz` regenerated.

---

## PR 3 — Webapp integration + parity gating

### Worker pipeline

In [web/js/inference-worker.js](../../web/js/inference-worker.js):

- New message type `run-vertebral-labeling`.
- Precondition: `workerState.segLabelsRAS` populated (segmentation ran first).
  Reject with `error` message otherwise.
- Handler steps:
  1. Load PAM50 templates (via `template-loader`).
  2. Run C2-C3 detector on `workerState.rasData`.
  3. Propagate discs using `workerState.segLabelsRAS` as the cord.
  4. Run `label_segmentation`.
  5. Emit `stageData` with `stage: 'vertebrae'`.
- Emits `progress` messages at each major step so the
  [worker protocol test](../../scripts/test_inference_worker_protocol.cjs)
  invariants still hold.

### UI

- New step section after segmentation: "Vertebral Labeling" with a Run button,
  enabled only when segmentation is complete.
- Add `vertebrae` to [sct-tasks.js](../../web/js/app/sct-tasks.js) but as a
  *post-segmentation step*, mirroring the morphometry pattern. Not a top-level
  task choice.
- Result rendering: NiiVue overlay using a categorical colormap with 31+
  entries (extend [labels.js](../../web/js/app/labels.js)).

### Manifest

Flip `vertebrae` to `supportStatus: "supported"`, `validationStatus: "passed"`
once the parity test passes.

### Fixture runner

In [scripts/run_browser_fixture_outputs.cjs](../../scripts/run_browser_fixture_outputs.cjs),
add a new branch for `batch_t2_label_vertebrae`:

1. Run spinalcord segmentation (existing path).
2. Run vertebrae labeling on the result.
3. Write the multi-label output as `browser_output.nii.gz`.

### Parity gating

In [scripts/test_fixture_parity_outputs.cjs](../../scripts/test_fixture_parity_outputs.cjs):

- Re-add `batch_t2_label_vertebrae` to `CRITICAL_BROWSER_OUTPUTS`.
- Extend `diceStats` to accept `mode: 'binary' | 'multilabel'`. Multi-label
  mode: per-label Dice averaged over all labels present in either volume.
- Threshold: empirically calibrated. Initial target mean Dice ≥ 0.55. If
  achievable Dice is materially lower, **pause and re-evaluate scope** rather
  than lower the gate.
- Foreground-ratio tolerance: ±0.2 on total foreground voxel count (cord seg
  is the same; only labels differ).
- Also assert: number of distinct positive labels in browser output is within
  ±2 of expected (catches "all voxels collapsed to one label" regressions).

### CI

[release.yml](../../.github/workflows/release.yml) already runs `npm test`
which transitively runs `test:fixtures`. Adding the vertebrae fixture means
release is blocked if vertebral parity drifts. No workflow change needed.

### AGENTS.md update

Per project rule, update [AGENTS.md](../../AGENTS.md) — add `vertebrae` to
the test surface table and remove the "intentionally absent" caveat about
`batch_t2_label_vertebrae`.

### Cleanup

- Delete the naive [labelVertebraeFromSegmentation](../../web/js/modules/sct-processing.js#L570).
- Delete or migrate any tests that depend on it
  ([test_sct_processing.cjs](../../scripts/test_sct_processing.cjs),
  [test_batch_processing_cases.cjs](../../scripts/test_batch_processing_cases.cjs)
  — verify which exact assertions reference it before deleting).

### Verification

1. `npm run test:fixtures:generate` produces a non-trivial multi-label
   `browser_output.nii.gz` for `batch_t2_label_vertebrae`.
2. `npm run test:fixtures` passes the new gate.
3. `npm run test:inference:e2e` and `npm run test:worker:protocol` extended
   to cover the chained pipeline.
4. Manual browser smoke: load `test_data/batch_t2_label_vertebrae/input.nii.gz`
   in the dev server, run segmentation, run vertebral labeling, confirm the
   rendered overlay shows banded vertebra labels along the cord.
5. Per CLAUDE.md, restart dev server and ask user to verify.

---

## Critical files (touched across all 3 PRs)

- [web/models/manifest.json](../../web/models/manifest.json) — new task entry
- [web/js/inference-worker.js](../../web/js/inference-worker.js) — new message routing
- [web/js/spinalcordtoolbox-app.js](../../web/js/spinalcordtoolbox-app.js) — new step orchestration
- [web/js/app/sct-tasks.js](../../web/js/app/sct-tasks.js) — task list update
- [web/js/app/labels.js](../../web/js/app/labels.js) — categorical colormap
- [web/index.html](../../web/index.html) — new step section
- [scripts/run_browser_fixture_outputs.cjs](../../scripts/run_browser_fixture_outputs.cjs) — fixture pipeline
- [scripts/test_fixture_parity_outputs.cjs](../../scripts/test_fixture_parity_outputs.cjs) — multi-label gate
- [package.json](../../package.json) — `test:vertebrae` script
- [AGENTS.md](../../AGENTS.md) — document new task and test surface
- New: `web/js/modules/vertebrae/*.js` (PR 1)
- New: `web/models/templates/PAM50/*.nii.gz` (PR 1, LFS)
- New (PR 2, Path A): `web/models/sct-c2c3-detector.onnx`
- New: `scripts/test_vertebrae_*.mjs` (PR 1)

## Reused utilities

- [web/nifti-js/](../../web/nifti-js/) — already loads NIfTI in the worker; reuse for PAM50.
- `localforage` — already used for ONNX model caching; reuse for PAM50.
- [scripts/test_inference_worker_e2e.cjs](../../scripts/test_inference_worker_e2e.cjs) —
  `runWorkerCase` export already added; PR 3 adds a vertebrae case.
- `diceStats` in [scripts/test_fixture_parity_outputs.cjs](../../scripts/test_fixture_parity_outputs.cjs) —
  extend with multi-label mode.
