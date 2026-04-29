# Current State of Vertebral Labeling in the Webapp

## Summary

Vertebral labeling is **partially implemented but entirely unintegrated**.
A naive helper exists in the JS library; nothing else is wired up.

## What exists

### Browser library function — naive only

[`labelVertebraeFromSegmentation`](../../web/js/modules/sct-processing.js) at
[sct-processing.js:570-596](../../web/js/modules/sct-processing.js#L570) is a
deterministic Z-slicing approximation:

```js
function labelVertebraeFromSegmentation(segmentation, dims, options = {}) {
  const startLevel = options.startLevel ?? 1;
  const slicesPerLevel = options.slicesPerLevel ?? 1;
  // for each slice with foreground:
  //   level = startLevel + floor((z - firstSlice) / slicesPerLevel)
}
```

This walks the segmentation slice-by-slice along Z and assigns increasing
integer labels. It does **not** detect intervertebral discs, does **not** use
anatomical landmarks, does **not** match SCT's label semantics (SCT labels
descending caudal→rostral; this function labels ascending), and produces output
that is fundamentally incompatible with SCT's batch reference.

### Tests for the helper

[scripts/test_sct_processing.cjs](../../scripts/test_sct_processing.cjs) and
[scripts/test_batch_processing_cases.cjs](../../scripts/test_batch_processing_cases.cjs)
both reference `labelVertebraeFromSegmentation` and confirm the function exists
and is callable. **Neither tests anatomical correctness** — they only verify
the output shape.

[scripts/batch-parity-lib.cjs:21](../../scripts/batch-parity-lib.cjs#L21) maps
the SCT command `sct_label_vertebrae` to:

```js
[/^sct_label_vertebrae\b/, { status: 'browser-capability', feature: 'vertebralLabeling' }]
```

This claims the feature is a "browser-capability" (i.e., implemented), which is
misleading given the only implementation is the naive helper.

## What's missing

| Piece | Status |
| --- | --- |
| Manifest entry for `vertebrae` task | absent |
| ONNX model for vertebrae | none — SCT itself doesn't use one for this |
| C2-C3 disc detector | absent (SCT uses external binary + OpenCV HOG+SVM) |
| PAM50 template assets | absent from `web/models/` |
| Worker message routing for vertebrae | absent in [inference-worker.js](../../web/js/inference-worker.js) |
| UI step / control | absent in [index.html](../../web/index.html) |
| Multi-step task chaining (segmentation → vertebrae) | not supported by current worker design |

## How the broken fixture is wired today

`test_data/batch_t2_label_vertebrae/` contains:

- `input.nii.gz` (~9.1 MB) — T2 anatomical
- `batch_output.nii.gz` (~244 KB compressed, ~52 MB raw) — SCT's multi-label output, datatype float64, label values `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]` mapped roughly one label per ~25 axial slices
- `browser_output.nii.gz` (~10 KB) — current "browser" output: binary mask under label 1 only

The output mismatch comes from
[scripts/run_browser_fixture_outputs.cjs:72-79](../../scripts/run_browser_fixture_outputs.cjs#L72)
which routes every fixture not containing `graymatter` in its name to the
spinalcord segmentation task:

```js
function resolveTaskAsset(fixtureId) {
  const taskId = fixtureId.includes('graymatter') ? 'graymatter' : 'spinalcord';
  // resolves to spinalcord ONNX model for batch_t2_label_vertebrae
}
```

So the fixture runs **spinalcord segmentation**, writes the binary 0/1 mask as
`browser_output.nii.gz`, and is then compared against SCT's vertebrally-labeled
expected output. The dimensions match by coincidence (because both are
operating on the same input volume), but the data is structurally different.

## Calibration data from the broken fixture

When the parity gates were calibrated during the test-coverage closeout, the
fixture was measured (using the binary-Dice metric, which collapses all SCT
labels to a single foreground class):

```
batch_t2_label_vertebrae:
  dims=3x64x320x320 datatype=64
  binary: expectedNz=21859 producedNz=23189 ratio=1.061 dice=0.9358
  multilabel: labels=[11,10,9,8,7,6,5,4,3,2,1] meanDice=0.0224
    label 11: aNz=400 bNz=0 dice=0.0000
    label 10: aNz=1464 bNz=0 dice=0.0000
    label 9: aNz=1808 bNz=0 dice=0.0000
    label 8: aNz=1744 bNz=0 dice=0.0000
    label 7: aNz=1621 bNz=0 dice=0.0000
    label 6: aNz=1882 bNz=0 dice=0.0000
    label 5: aNz=2356 bNz=0 dice=0.0000
    label 4: aNz=2567 bNz=0 dice=0.0000
    label 3: aNz=2484 bNz=0 dice=0.0000
    label 2: aNz=2185 bNz=0 dice=0.0000
    label 1: aNz=3348 bNz=23189 dice=0.2466
```

Binary Dice 0.9358 confirms the cord segmentation is essentially correct.
Multi-label mean Dice 0.0224 (effectively 0) confirms there is no labeling
information at all in the browser output.

## Fixture's intentional removal from gates

In the test-coverage closeout, `batch_t2_label_vertebrae` was deliberately
**not** added to `CRITICAL_BROWSER_OUTPUTS` in
[test_fixture_parity_outputs.cjs](../../scripts/test_fixture_parity_outputs.cjs).
A note in [AGENTS.md](../../AGENTS.md) flags it as a known gap:

> `batch_t2_label_vertebrae` is intentionally absent from
> `test_fixture_parity_outputs.cjs` — the browser webapp does not yet emit
> per-vertebra labels (1-11), only a binary mask. Re-add with multi-label
> gating once vertebral labeling lands.

The vertebral labeling implementation is what unblocks adding this fixture
back to the parity gate.
