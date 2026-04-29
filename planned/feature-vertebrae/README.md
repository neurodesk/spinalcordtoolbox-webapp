# Feature: Anatomical Vertebral Labeling in the Browser

This directory documents the planned port of SCT's `sct_label_vertebrae` algorithm
to the browser webapp. It is the result of a discovery pass triggered by the
`batch_t2_label_vertebrae` fixture failing parity: the browser was producing only
a binary spinalcord mask under label 1, while SCT produces a multi-label volume
(labels 1–11+) anchored to the C2-C3 disc.

## Documents

| File | Purpose |
| --- | --- |
| [01-current-state.md](01-current-state.md) | What the webapp currently has, what's missing, and how the broken fixture is wired today |
| [02-sct-algorithm.md](02-sct-algorithm.md) | Detailed walkthrough of SCT's classical algorithm: top-level flow, C2-C3 detection, template matching, label propagation |
| [03-asset-inventory.md](03-asset-inventory.md) | PAM50 templates and other assets the port depends on |
| [04-porting-analysis.md](04-porting-analysis.md) | Per-component port difficulty rating: tractable, moderate, and hazardous |
| [05-implementation-plan.md](05-implementation-plan.md) | The 3-PR rollout plan (algorithmic core → C2-C3 detector → webapp integration) |
| [06-risks-and-decisions.md](06-risks-and-decisions.md) | Open questions, risks, and decisions that need to be made before / during implementation |

## TL;DR

- **SCT's `sct_label_vertebrae` is classical, not ML.** The propagation/labeling
  core is template matching with mutual information against PAM50 disc templates.
- **The C2-C3 disc detector is the only ML-ish part** and is the hardest to port:
  it's an OpenCV HOG+SVM driven by an external binary `isct_spine_detect` with
  YAML weights (~11 KB).
- **Recommended approach (D1 in conversation history):** algorithmic port to
  pure JavaScript for the propagation core; train a small CNN replacement for
  C2-C3 detection (justified because porting OpenCV HOG+SVM YAML semantics to
  JS is brittle and the C2-C3 anchor cascades through every downstream label).
- **Asset cost:** ~30 MB for the T2 PAM50 template + levels map. Already shipping
  ~250 MB of ONNX so this is incremental.
- **Existing browser helper** [labelVertebraeFromSegmentation](../../web/js/modules/sct-processing.js)
  at line 570 is a naive Z-slicing approximation. It is **not** the basis of the
  port; it should be deleted in PR 3 once the real implementation lands.

## Origin of these notes

These findings were collected during a planning conversation on 2026-04-28
prompted by the test-coverage close-out work. The investigation accessed:

- The vendored SCT source at `.tmp_sct_models/spinalcordtoolbox-src/spinalcordtoolbox/vertebrae/`
- SCT's published documentation at https://spinalcordtoolbox.com/user_section/command-line/sct_label_vertebrae.html
- The webapp's manifest, inference worker, and existing `batch_t2_label_vertebrae` fixture pair

No code was changed during discovery.
