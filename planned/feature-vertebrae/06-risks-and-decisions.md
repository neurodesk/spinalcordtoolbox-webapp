# Risks, Decisions, and Open Questions

This is the place to surface things that should not be silently absorbed
during implementation.

## Open decisions

### D1 — C2-C3 detector strategy (PR 2 kickoff)

**Choices:**

- **Path A (recommended):** train a small disc-localization CNN, ship as ONNX.
- **Path B:** vendor SCT's OpenCV HOG+SVM YAML and reimplement HOG+SVM in JS.
- **Path C (interim):** ship a hand-tuned heuristic (e.g., distance from top
  of cord segmentation) and accept lower parity until Path A or B lands.

**Suggested decision-making:** 1-day spike at PR 2 kickoff. If we have access
to SCT's training data and a working PyTorch environment, do Path A. If not,
fall back to Path B. Path C is only acceptable as a temporary placeholder
that does not get merged to main.

### D2 — Operate in straightened space or original space?

SCT runs the whole algorithm in straightened-cord space (after `flatten_sagittal`).
We can either:

- **Port `flatten_sagittal`** (requires affine resampling — moderate JS effort,
  potentially WebGL-accelerated). Best parity.
- **Operate in the original space.** Less code, lower fidelity, especially
  for curved cervical curves. Maybe acceptable for cervical-only fixtures
  (which `batch_t2_label_vertebrae` is) but degrades on lumbar.

**Recommendation:** Start in original space for PR 1's tests (synthetic
volumes are already aligned). Decide for the real pipeline at PR 3 kickoff
based on observed parity.

### D3 — Vertebrae as a step or as a task?

Today's task selector ([sct-tasks.js](../../web/js/app/sct-tasks.js)) implies
each task produces an independent output. Vertebrae is a *post-segmentation
step* — it requires a prior cord segmentation. Two UX patterns:

- **Step pattern (recommended):** vertebrae appears as a sub-step under the
  segmentation, like morphometry. Run button is enabled only when segmentation
  is complete.
- **Task pattern:** vertebrae is a top-level task that internally chains
  segmentation. Hides the dependency from the user.

Recommendation: step pattern, mirrors how morphometry already works.

### D4 — Multi-label parity threshold

The plan suggests initial mean Dice ≥ 0.55 on `batch_t2_label_vertebrae`.
This is a placeholder. Real threshold will be calibrated empirically once the
end-to-end pipeline runs. **Process for setting it:**

1. Run the pipeline on the fixture.
2. Compute multi-label mean Dice.
3. Set threshold to `floor(currentDice * 100) / 100 - 0.05`.
4. If `currentDice < 0.40`, treat as a sign that the algorithm is not working
   well enough to ship and pause.
5. If `0.40 ≤ currentDice < 0.55`, raise this with the user before merging.

## Hard risks (could blow up the parity gate)

### R1 — C2-C3 anchor accuracy

The single biggest risk. A 3-slice error in the anchor cascades into every
downstream label. Mitigation: PR 2 must include real-data tests on the
fixture, not just synthetic.

### R2 — MI numerical drift

Even with a correct algorithm, JS floating-point arithmetic on histogram
counts can shift the MI peak by 1–2 Z slices. Mitigation: PR 1 cross-validation
test against scikit-learn reference values with bit-level inputs and ~1e-6
tolerance.

### R3 — Adaptive distance correction is unstable on noisy anchors

SCT's adaptive distance corrector
([core.py:183-197](https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/spinalcordtoolbox/vertebrae/core.py#L183))
amplifies any error in already-found discs. If we get the C2-C3 anchor wrong,
the propagation can drift further. Mitigation: maximum correction factor cap;
fall back to template distances when correction factor exceeds bounds.

### R4 — PAM50 license terms

Verify before vendoring. Unknown but plausibly restrictive distribution
clauses. If problematic, consider runtime fetch from an SCT-hosted CDN
instead of bundling.

### R5 — Bundle size

PR 1 adds ~20 MB of compressed assets. PR 2 (Path A) adds another ~1–5 MB.
Already at ~250 MB for ONNX models, so this is incremental — but watch for
cumulative impact when T1/T2S templates are added later.

## Soft risks (worth knowing about)

### S1 — Scope creep

This feature is a tempting place to also fix:

- The naive `labelVertebraeFromSegmentation` callers (delete in PR 3).
- The misleading `batch-parity-lib.cjs` mapping that calls vertebrae a
  "browser-capability" today.
- Multi-step task chaining infrastructure in the worker.

Stay disciplined. The chaining infrastructure especially is tempting to
generalize but should be vertebrae-specific in PR 3 and generalized later
if a third multi-step task lands.

### S2 — Test data licensing

Synthetic test inputs in PR 1 should be hand-generated, not derived from
patient data. The `batch_t2_label_vertebrae` fixture already exists and is
licensed under the SCT umbrella, so PR 3 reusing it is fine.

### S3 — Browser memory

PAM50 templates are ~10 MB each, decompressed to ~50 MB. Cord segmentations
are ~200 KB. Multi-label outputs are ~50 MB. Total working set during
vertebrae inference: ~200 MB. Fine on desktop, may strain mobile. Out of
scope for now — ship and observe.

## Things that look like risks but aren't

### Pediatric scaling

`scale_dist` is a single multiplicative factor. Ships as a UI knob in PR 3
with default 1.0. No special infrastructure.

### Contrast handling

Parameter-only — same algorithm runs for T1/T2/T2*. Just need different
template files. T1/T2S templates can be added when the corresponding
fixtures are added.

### Matching SCT's two output files

The disc-only output (`*_labeled_disc.nii.gz`) is not needed for fixture
parity. Skip in v1; the labeled segmentation is the only required output.

## Decisions already made (recorded for posterity)

- **D1:** Algorithmic port (D1 in conversation history), not new ONNX (D2),
  not hybrid (D3). User decision on 2026-04-28.
- **Heavy parity tests run only on release**, not on every push. Recorded in
  the test-coverage closeout.
- **Vertebrae task starts as `unsupported` in the manifest** in PR 1. UI
  visibility comes only when PR 3 flips the flag.
- **No native-SCT centerline/morphometry parity** — out of scope (set during
  test-coverage closeout).
