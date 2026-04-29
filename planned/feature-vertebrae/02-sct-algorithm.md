# SCT's `sct_label_vertebrae` Algorithm

This document is a structured reference for SCT's classical algorithm so we have
all behavior pinned down before porting. All file references are within the
SCT source repository; the webapp keeps a vendored copy at
`.tmp_sct_models/spinalcordtoolbox-src/spinalcordtoolbox/vertebrae/`.

## Architecture

The algorithm is **classical, not deep learning** for the propagation core.
Only the C2-C3 disc detector uses an ML-ish pipeline (OpenCV HOG + SVM),
not a neural network.

There are exactly three Python files:

- `core.py` (520 lines) — main algorithm
- `detect_c2c3.py` (170 lines) — initialization step (find C2-C3 disc)
- `__init__.py` (empty)

## Inputs and outputs

**Inputs**

- Anatomical image (T1, T2, or T2*)
- Spinal cord segmentation (binary mask)
- Contrast string ('T1' / 'T2' / 'T2S')
- Parameter dict: search-window sizes (`size_RL=1`, `size_AP=11`, `size_IS=19`),
  `shift_AP=32`
- `init_disc`: a tuple (z, value) — anchor disc position and label
  (typically `(z_C2C3, 2)` from `detect_c2c3`)
- `scale_dist`: float scaling factor for inter-disc distances; default 1.0,
  reduced (~0.8) for pediatric subjects
- Path to a PAM50 template directory

**Outputs** (two NIfTI files)

1. `*_labeled.nii.gz` — same dimensions as the input segmentation. Each
   foreground voxel of the cord is replaced with the integer label of the
   vertebral level it belongs to. Background voxels stay 0.
2. `*_labeled_disc.nii.gz` — sparse image with one labeled voxel per detected
   disc, at the cord centerline. Disc value is offset by `+1` for legacy
   compatibility.

For the immediate fixture-parity work, only output #1 is required.

## Top-level flow

`vertebral_detection()` in `core.py:45-253`:

1. **Load template assets** (`core.py:62-72`)
   - `id_label_dct = {'T1': 0, 'T2': 1, 'T2S': 2}` chooses the template image.
   - Calls `get_file_label()` to load the contrast-specific template image
     (`PAM50_t1.nii.gz` / `PAM50_t2.nii.gz` / `PAM50_t2s.nii.gz`) and the
     vertebral level map (`PAM50_levels.nii.gz`).
   - Gaussian-smooth the input anatomy with sigma=`[3, 1, 1]`.

2. **Extract template inter-disc distances** (`core.py:93-112`)
   - Pull a 1D centerline profile from the template levels map at fixed
     `(xc, yc, :)` coordinates.
   - Find the Z indices where the level value transitions
     (`diff_centerline_level.nonzero()`).
   - Compute distances between consecutive transitions in voxel units.
   - Multiply by `scale_dist`.

3. **Iterative disc search** (`core.py:147-230`)
   - Start at the C2-C3 anchor `init_disc`.
   - Walk **superior** first, then **inferior**.
   - For each next disc, predict the next Z by adding the (scaled, adaptively
     corrected) template inter-disc distance.
   - Refine that prediction by calling `compute_corr_3d()` to find the local
     MI peak in a small Z-range around it.
   - Append `(z, value)` to the running disc list.
   - Adaptive correction (`core.py:183-197`): take the ratio of subject-side
     inter-disc distance to template-side inter-disc distance for each
     already-found disc pair; average those ratios into a `correcting_factor`
     and apply to the next predicted distance.

4. **Label propagation**
   - `label_segmentation()` (`core.py:462-489`): for each foreground voxel at
     slice z, assign the label of the **nearest disc above** it. Yields the
     step-shaped multi-label cord.
   - `label_discs()` (`core.py:492-520`): write each detected disc's voxel at
     the cord centerline.

## C2-C3 disc detection

`detect_c2c3()` in `detect_c2c3.py:40-141`:

1. **Sagittal flatten** (line 61-62) using `flatten_sagittal()` to center the
   cord in the R-L plane.
2. **Mid-slice average** (line 70-78): take 7 sagittal slices around the
   image midline and average them into a single 2D image.
3. **HOG+SVM detection** (line 80-87)
   - Loads OpenCV YAML model from `$SCT_DIR/data/c2c3_disc_models/{contrast}_model.yml`.
   - Calls external binary `isct_spine_detect`.
   - Output is a 2D probability heatmap.
   - Window size 32×32 px, 9 HOG bins, block size 8×8.
   - Model file is ~11 KB (raw SVM weights serialized in YAML arrays).
4. **Post-processing** (line 96-128)
   - Mask predictions to within ±25 mm of the spinal cord centerline.
   - Zero out predictions above the cord segmentation.
   - Find the peak voxel.
   - Lift the 2D peak to 3D by combining its (P-A, I-S) coordinates with the
     R-L coordinate from the cord centerline.

Returns a 3D image with a single voxel labeled `3` at the C2-C3 posterior
edge. The propagation core then takes that voxel's Z coordinate and the label
value `2` to mean "the disc between C2 and C3".

## Template matching: `compute_corr_3d`

`core.py:338-459`. Inputs:

- `src`, `target`: 3D arrays for the subject anatomy and template
- Center voxel `(x, y, z)` in the subject
- Per-axis sizes `xsize`, `ysize`, `zsize` (RL, AP, IS half-widths)
- Reference voxel `(xtarget, ytarget, ztarget)` in the template
- `zrange`: list of Z displacements to test, default `[-10, ..., 10]`

Process:

1. Extract a 3D **pattern** from the template at the reference voxel.
2. For each `dz` in `zrange`, extract a same-sized **chunk** from the subject
   at `(x, y, z + dz)`. Pad with zeros if the box runs outside the volume.
3. Score each chunk against the pattern with mutual information.
4. Pick the `dz` with maximum MI.
5. Threshold: if peak MI < 0.2, fall back to the predicted Z without
   refinement.

**Similarity metric**: mutual information via `mutual_info_score` from sklearn
on a 16-bin 2D histogram. Not normalized MI.

## Pediatric and contrast handling

- **Contrast** is parameter-only: same algorithm runs for T1/T2/T2*; only the
  template image differs.
- **Pediatric** is parameter-only: `--scale-dist 0.8` (or similar) shrinks
  inter-disc distances. No separate template, no separate code path.

## Pure-Python helpers used

From `spinalcordtoolbox/math.py`:

- `mutual_information(x, y, nbins=16)` — joint histogram + entropy, easily
  ported.
- `correlation(x, y, type='pearson')` — trivial.
- `dilate(data, size, shape)` — uses `skimage` for footprint generation but the
  footprint logic is plain numpy and easily ported.

From `scipy.ndimage`:

- `gaussian_filter()` — separable convolution; standard.
- `center_of_mass()` — weighted average of coordinates.
- `distance_transform_edt()` — Euclidean distance transform; used by
  `expand_labels()`. Doable in JS but requires a careful implementation.

From `skimage`:

- `transform.warp()` — affine resampling, used by `flatten_sagittal()`.
  Non-trivial in JS; consider WebGL/regl for performance.

NIfTI I/O is via `nibabel`. The webapp already has a vendored
[nifti-js](../../web/nifti-js/index.js) library to reuse.

## Code paths the port can sidestep

- **`_labeled_disc.nii.gz` output**: not needed for fixture parity. Skip in v1.
- **T1 and T2S contrasts**: only T2 is required for `batch_t2_label_vertebrae`.
- **Mouse / lumbar / pediatric-specific templates**: out of scope.
- **Verbose logging**: SCT's `sct.printv` logging machinery is not relevant.

## Key numerical sensitivities

- **MI bin edges**: numerical drift between `numpy.histogram2d` and a hand-rolled
  JS histogram can shift the MI peak by 1–2 Z slices, which compounds across
  every subsequent disc. Reference values must be committed alongside test
  inputs and verified bit-for-bit (or to a small tolerance) on the JS side.
- **Sub-voxel disc Z**: SCT's algorithm operates in integer Z. No interpolation
  is needed.
- **Affine handling**: the algorithm is run in straightened-cord space. Either
  the JS port also operates in straightened space (requires porting
  `flatten_sagittal`) or it operates in the original space and accepts a
  small accuracy cost. **Open question for PR 1.**
