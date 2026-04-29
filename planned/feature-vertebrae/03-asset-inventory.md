# Asset Inventory

What we need to bundle into the webapp to support vertebral labeling.

## PAM50 templates (required, ~30 MB compressed)

The PAM50 template is SCT's atlas of the spinal cord. SCT auto-downloads it on
first use; we need to vendor the relevant subset into `web/models/templates/PAM50/`.

| File | Size (compressed) | Purpose |
| --- | --- | --- |
| `PAM50_t2.nii.gz` | ~10 MB | T2-weighted reference image — used as the template for MI matching against subject T2 anatomy |
| `PAM50_levels.nii.gz` | ~10 MB | Vertebral level discretization (one integer label per voxel along the cord) — used to extract the inter-disc distance vector |
| `info_label.txt` | <1 KB | Metadata mapping `id_label` integers (0/1/2/...) to filenames |

For the immediate fixture (`batch_t2_label_vertebrae`) only the T2 template and
levels map are required.

### Deferred for later

| File | Size | Required when |
| --- | --- | --- |
| `PAM50_t1.nii.gz` | ~10 MB | T1-contrast vertebrae fixtures land |
| `PAM50_t2s.nii.gz` | ~10 MB | T2*-contrast vertebrae fixtures land |
| Pediatric / mouse / lumbar templates | varies | Out of scope |

## C2-C3 disc detector model (PR 2 decision)

SCT ships an OpenCV HOG+SVM detector as a YAML file:

```
$SCT_DIR/data/c2c3_disc_models/t1_model.yml
$SCT_DIR/data/c2c3_disc_models/t2_model.yml
```

Each is ~11 KB.

**Two ways to ship the C2-C3 detector:**

- **Path A: train a CNN replacement, export to ONNX.**
  Estimated 1–5 MB ONNX. We already use ONNX Runtime in the worker, so this
  fits the existing model-loading machinery.

- **Path B: vendor the YAML and a JS HOG+SVM implementation.**
  Estimated <50 KB shipped (the YAML + a small JS lib). Heavier porting effort
  and higher parity risk.

See [04-porting-analysis.md](04-porting-analysis.md) for the trade-off and
[05-implementation-plan.md](05-implementation-plan.md) for when this decision
is made.

## Total bundle impact

| Component | Compressed | Existing webapp ships |
| --- | --- | --- |
| Current ONNX models (spinalcord, graymatter) | ~250 MB | yes |
| New: PAM50 T2 + levels (PR 1) | ~20 MB | + |
| New: C2-C3 detector (PR 2, Path A) | ~1–5 MB | + |
| New: PAM50 T1 + T2S (deferred) | ~20 MB | later |

## Distribution plan

- Store under `web/models/templates/PAM50/` (new directory).
- Track via Git LFS, mirroring the existing `*.onnx` workflow.
- Extend `.gitattributes` if necessary.
- Extend `web/setup.sh` to download these assets (it already knows how to fetch
  ONNX Runtime WASM — adding NIfTI templates is structurally similar).
- Extend the deploy workflow's LFS-pointer check at
  [.github/workflows/deploy-pages.yml:64-78](../../.github/workflows/deploy-pages.yml)
  to verify the new `.nii.gz` files are real binaries, not LFS pointers.

## Licensing

- **PAM50** is published by NeuroPoly under [an open license](https://github.com/spinalcordtoolbox/PAM50).
  Verify license terms permit redistribution via GitHub Pages and add a
  `web/models/templates/PAM50/LICENSE` file.
- **OpenCV YAML model** (Path B only) is part of SCT and is licensed under
  the SCT umbrella. Verify before vendoring.
- **Trained CNN** (Path A) is our own asset — we control its license.
