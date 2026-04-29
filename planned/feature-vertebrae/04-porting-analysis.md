# Per-Component Porting Difficulty Analysis

Each piece of SCT's vertebral labeling rated for difficulty of port to the
browser. Difficulty here is a function of: complexity of the math, dependencies
on numpy/scipy/skimage, sensitivity to numerical drift, and availability of a
reasonable JS substitute.

## Tractable (port directly to JS)

### Mutual information

`spinalcordtoolbox/math.py:246-260`. Just a 2D histogram followed by joint
entropy. Maps to ~30 lines of JS. Numerical parity with sklearn's
`mutual_info_score` is achievable if we use the same bin edges and the same
entropy formula.

### Pearson correlation

`spinalcordtoolbox/math.py:263-279`. Trivial.

### Center of mass

`scipy.ndimage.center_of_mass` is just a coordinate-weighted average. ~10 lines
of JS.

### `compute_corr_3d`

The main template-matching loop. Inputs are arrays + ints, output is a single
Z value. No external deps once MI is ported. The numerical sensitivity is in
the MI implementation, not in this loop itself.

### Label propagation (`label_segmentation`, `label_discs`)

Pure integer logic over the segmentation array. ~50 lines of JS.

### Inter-disc distance extraction

Walks the template levels map at the centerline and finds transitions. Pure
array logic.

### Gaussian smoothing

Separable 3D Gaussian. Standard signal processing — write three 1D passes
(one per axis) using a precomputed kernel. ~40 lines of JS for arbitrary sigma.

### Morphological dilation (if needed)

`spinalcordtoolbox/math.py` `dilate()` uses skimage for footprint generation,
but the actual dilation is plain numpy. The footprint logic for ball/disk is
itself just `x² + y² + z² ≤ r²`. ~50 lines.

## Moderate (porting requires care)

### Distance transform (Euclidean)

Used inside `expand_labels`. Naive O(n²) is unacceptable for 3D volumes;
needs the standard separable algorithm (Felzenszwalb-Huttenlocher). Doable
but adds ~150 lines and one round of testing for edge cases.

### Affine resampling / `flatten_sagittal`

Used by the C2-C3 detector preprocessing. Requires a 3D affine warp on a
NIfTI volume. Pure-JS is doable but slow on a CPU; for production use this
is a candidate for WebGL acceleration via a small fragment shader. **Decision
deferred to PR 2.**

If we choose Path A (CNN-based C2-C3 detector), we may avoid most of the
flatten step by training the CNN on raw mid-sagittal slices.

### NIfTI I/O for templates

The webapp already vendors [nifti-js](../../web/nifti-js/) for the worker.
Reuse it for PAM50 loading. The only complexity is handling the level map's
data type (likely `int16` or `float32`).

### Asset caching

PAM50 templates are ~10 MB each. We should cache them in `localforage` (already
used for ONNX model caching). Not hard but needs a clean abstraction.

## Hazardous (do not port directly)

### C2-C3 disc detector — OpenCV HOG+SVM via external binary

This is the *only* component that should make us reach for an alternative
approach rather than a direct port. Reasons:

1. **External binary dependency.** SCT calls `isct_spine_detect` as a
   subprocess. We obviously can't ship a binary from the webapp.
2. **OpenCV YAML format.** SCT's YAML stores OpenCV-specific SVM serialization
   (kernel type, support vectors, decision function). Porting this to JS
   requires either (a) an OpenCV.js dependency (~10 MB minified), or (b) a
   hand-rolled YAML parser plus HOG+SVM evaluator.
3. **Sliding window + non-max suppression.** Even after the SVM is ported, the
   detection loop applies HOG over a sliding window and runs NMS to dedupe
   responses. Each step is a parity hazard.
4. **Cascade of sensitivity.** The C2-C3 anchor is the *first* disc in the
   propagation chain. A 3-slice error here translates to mislabeling every
   downstream level. There is no recovery.

Recommended alternative: **train a small disc-localization CNN once, ship as
a 1–5 MB ONNX file**, integrate into the existing ONNX runtime in the worker.
Concretely:

- Input: mid-sagittal 7-slice average of the T2 anatomy (matches SCT's
  preprocessing).
- Output: 2D heatmap of disc-likelihood, peaked at the C2-C3 disc.
- Training data: synthetic from PAM50 + SCT's own annotated dataset (publicly
  available).
- Loss: MSE on a Gaussian-blurred heatmap centered at the ground-truth disc
  location.

This is the single piece of new ML work in the entire feature.

### `expand_labels`

Used in `label_segmentation` to grow labels into adjacent voxels. Needs the
distance transform from above. Hazard is in correctness across volume
boundaries, not in algorithmic complexity.

## Sensitivity ranking

If asked "what is the one thing that could blow up the parity gate?", the
answer is: **C2-C3 anchor accuracy.** Every other component has localized
failure modes (a missed disc here, a misplaced label there). The C2-C3 anchor
sets the entire coordinate system for the propagation, and a 1-slice anchor
error becomes a 1-slice error on every downstream label.

The second most sensitive piece is **MI numerical parity**. If our JS MI
disagrees with SCT's by even small amounts, the search-window peak Z can shift
by 1–2 voxels per disc, and the adaptive distance corrector compounds the drift.

## Test strategy informed by sensitivity

- For low-sensitivity components (label propagation, inter-disc distances,
  gaussian smoothing): unit tests against synthetic inputs are sufficient.
- For MI: cross-validate against scikit-learn reference values committed as
  test fixtures. Bit-for-bit agreement is unrealistic in floating point but
  agreement to ~1e-6 should be achievable.
- For the C2-C3 detector: unit tests are insufficient. Need integration tests
  on real subjects with ground-truth disc Z, asserting detection within ±2
  voxels.
- For the full pipeline: only the existing fixture-parity gate matters. Per-
  label mean Dice ≥ 0.55 (placeholder) on `batch_t2_label_vertebrae`.
