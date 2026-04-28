# Quickstart: Batch Processing Parity

## 1. Confirm Active Feature

```bash
cat .specify/feature.json
sed -n '1,220p' specs/002-batch-processing-parity/spec.md
sed -n '1,260p' specs/002-batch-processing-parity/plan.md
```

## 2. Install Dependencies

```bash
npm install
```

## 3. Inspect Current Fixtures

```bash
find test_data -maxdepth 2 -type f | sort
sed -n '1,280p' test_data/batch_processing.sh
```

Expected initial fixture pattern:

```text
test_data/batch_*/input.nii.gz
test_data/batch_*/batch_output.nii.gz
```

## 4. Run Existing Validation

```bash
npm run test:processing
npm run test:batch:webapp
```

## 5. Run Full Project Test Gate

```bash
npm test
```

## 6. Required Negative Checks During Implementation

Before considering the feature complete, verify the batch parity test fails for:

- an active command in `test_data/batch_processing.sh` with no browser equivalent
- an artifact-producing active command with no fixture
- a fixture without a tolerance policy
- a changed expected output that exceeds its fixture tolerance policy
- a supported segmentation task without validated browser-runnable assets
- an unsupported/native-only active batch step

## 7. Privacy and Diagnostic Check

Review failing diagnostics and confirm they include only local fixture
identifiers, aggregate counts, mismatch categories, and numeric summaries. They
must not print voxel arrays, patient-derived metadata, screenshots, or full
image contents.
