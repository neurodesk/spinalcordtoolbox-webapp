#!/usr/bin/env node
'use strict';

/**
 * Reference-output generator for the batch-parity fixtures. Drives the SCT
 * inference pipeline (shared with the browser worker via web/js/inference-pipeline.js)
 * on each fixture's input and writes the resulting browser_output.nii.gz.
 *
 * Single source of truth: this script uses the same pipeline module as
 * web/js/inference-worker.js. Patch size + threshold come from the per-task
 * model manifest at web/models/manifest.json so the two paths can never drift.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ort = require('onnxruntime-node');
const fixtures = require('./batch-parity-fixtures.cjs');
const { loadNifti, compareNiftiOutputs } = require('./batch-parity-lib.cjs');
const pipeline = require(path.resolve(__dirname, '../web/js/inference-pipeline.js'));

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8'));
const THRESHOLD_OVERRIDE = process.env.BROWSER_THRESHOLD ? Number(process.env.BROWSER_THRESHOLD) : null;
const MIN_COMPONENT_SIZE_OVERRIDE = process.env.BROWSER_MIN_COMPONENT_SIZE ? Number(process.env.BROWSER_MIN_COMPONENT_SIZE) : null;

function readNiftiRaw(filePath) {
  const compressed = fs.readFileSync(filePath);
  const bytes = filePath.endsWith('.gz') ? zlib.gunzipSync(compressed) : compressed;
  if (bytes.readInt32LE(0) !== 348) throw new Error(`Only little-endian NIfTI-1 is supported: ${filePath}`);
  const dims = [bytes.readInt16LE(42), bytes.readInt16LE(44), bytes.readInt16LE(46)];
  const datatype = bytes.readInt16LE(70);
  const voxOffset = Math.ceil(bytes.readFloatLE(108));
  const slopeRaw = bytes.readFloatLE(112);
  const interRaw = bytes.readFloatLE(116);
  const slope = Number.isFinite(slopeRaw) && slopeRaw !== 0 ? slopeRaw : 1;
  const inter = Number.isFinite(interRaw) ? interRaw : 0;
  const n = dims[0] * dims[1] * dims[2];
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (datatype === 2) data[i] = bytes[voxOffset + i] * slope + inter;
    else if (datatype === 4) data[i] = bytes.readInt16LE(voxOffset + i * 2) * slope + inter;
    else if (datatype === 8) data[i] = bytes.readInt32LE(voxOffset + i * 4) * slope + inter;
    else if (datatype === 16) data[i] = bytes.readFloatLE(voxOffset + i * 4) * slope + inter;
    else if (datatype === 64) data[i] = bytes.readDoubleLE(voxOffset + i * 8) * slope + inter;
    else throw new Error(`Unsupported datatype ${datatype}: ${filePath}`);
  }
  return { header: bytes.subarray(0, voxOffset), dims, data };
}

function writeUint8NiftiGz(outPath, header, dims, labels) {
  const out = Buffer.alloc(header.length + labels.length);
  Buffer.from(header).copy(out, 0, 0, header.length);
  out.writeInt16LE(2, 70);
  out.writeInt16LE(8, 72);
  out.writeInt16LE(3, 40);
  out.writeInt16LE(dims[0], 42);
  out.writeInt16LE(dims[1], 44);
  out.writeInt16LE(dims[2], 46);
  out.writeInt16LE(1, 48);
  out.writeFloatLE(1, 112);
  out.writeFloatLE(0, 116);
  out.writeFloatLE(1, 124);
  out.writeFloatLE(0, 128);
  Buffer.from(labels.buffer, labels.byteOffset, labels.byteLength).copy(out, header.length);
  fs.writeFileSync(outPath, zlib.gzipSync(out));
}

/**
 * Look up the model asset (patchSize, defaults) used for a given fixture.
 * Mirrors the manifest the browser worker reads.
 */
function resolveTaskAsset(fixtureId) {
  const taskId = fixtureId.includes('graymatter') ? 'graymatter' : 'spinalcord';
  const task = MANIFEST.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`No task in manifest matching fixture id ${fixtureId}`);
  const asset = task.modelAssets[0];
  if (!asset) throw new Error(`No model asset for task ${taskId}`);
  return { taskId, asset };
}

function diceVsExpected(producedLabels, expectedData) {
  let expectedNz = 0, producedNz = 0, intersection = 0;
  for (let i = 0; i < expectedData.length; i++) {
    const e = expectedData[i] > 0;
    const p = producedLabels[i] > 0;
    if (e) expectedNz++;
    if (p) producedNz++;
    if (e && p) intersection++;
  }
  const dice = expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1;
  return { expectedNz, producedNz, intersection, dice };
}

async function runCase(fixture) {
  const inputPath = path.join(ROOT, fixture.inputPath);
  const outPath = path.join(path.dirname(inputPath), 'browser_output.nii.gz');
  const { taskId, asset } = resolveTaskAsset(fixture.id);
  const modelPath = path.join(ROOT, 'web/models', asset.filename);

  const { header, dims, data } = readNiftiRaw(inputPath);
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const patchSize = asset.patchSize;
  const threshold = THRESHOLD_OVERRIDE != null ? THRESHOLD_OVERRIDE : (asset.inferenceDefaults?.probabilityThreshold ?? 0.5);
  const minComponentSize = MIN_COMPONENT_SIZE_OVERRIDE != null ? MIN_COMPONENT_SIZE_OVERRIDE : (asset.inferenceDefaults?.minComponentSize ?? 10);

  const runPatch = async (patch, patchDims) => {
    const [p0, p1, p2] = patchDims;
    const tensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
    const result = await session.run({ [inputName]: tensor });
    return result[outputName].data;
  };

  const result = await pipeline.runInferencePipeline(
    { data, dims, patchSize },
    runPatch,
    {
      threshold,
      minComponentSize,
      testTimeAugmentation: !!asset.inferenceDefaults?.testTimeAugmentation,
      onLog: () => {},
      onProgress: (stepsDone, totalSteps) => {
        if (totalSteps && stepsDone % 5 === 0) process.stderr.write(`${fixture.id}: ${stepsDone}/${totalSteps}\n`);
      },
      onPatchStats: () => {}
    }
  );
  await session.release();

  writeUint8NiftiGz(outPath, header, dims, result.labels);

  const expected = loadNifti(path.join(ROOT, fixture.expectedOutputPath));
  const produced = loadNifti(outPath);
  const mismatches = compareNiftiOutputs(expected, produced, fixture.tolerancePolicy, 'browser_output.nii.gz', 'browser_output.nii.gz');
  const { expectedNz, producedNz, dice } = diceVsExpected(produced.data, expected.data);
  return { id: fixture.id, outPath: path.relative(ROOT, outPath), mismatches, expectedNz, producedNz, dice, threshold, taskId };
}

(async () => {
  const results = [];
  const filter = process.env.BROWSER_FIXTURE_FILTER || '';
  const selectedFixtures = fixtures.FIXTURE_CASES.filter(fixture => !filter || fixture.id.includes(filter));
  for (const fixture of selectedFixtures) {
    results.push(await runCase(fixture));
  }
  for (const result of results) {
    console.log(JSON.stringify({
      id: result.id,
      outPath: result.outPath,
      mismatchCount: result.mismatches.length,
      firstMismatch: result.mismatches[0] || null,
      expectedNz: result.expectedNz,
      producedNz: result.producedNz,
      dice: Number(result.dice.toFixed(6)),
      threshold: result.threshold,
      taskId: result.taskId
    }));
  }
})();
