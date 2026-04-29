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

function resampleVolume(data, dims, srcSpacing, tgtSpacing) {
  const [nx, ny, nz] = dims;
  const newDims = [
    Math.max(1, Math.round(dims[0] * srcSpacing[0] / tgtSpacing[0])),
    Math.max(1, Math.round(dims[1] * srcSpacing[1] / tgtSpacing[1])),
    Math.max(1, Math.round(dims[2] * srcSpacing[2] / tgtSpacing[2]))
  ];
  const [nnx, nny, nnz] = newDims;
  const result = new Float32Array(nnx * nny * nnz);
  const scaleX = (nx - 1) / Math.max(nnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(nny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(nnz - 1, 1);
  for (let z = 0; z < nnz; z++) {
    const sz = z * scaleZ;
    const z0 = Math.floor(sz);
    const z1 = Math.min(z0 + 1, nz - 1);
    const wz = sz - z0;
    for (let y = 0; y < nny; y++) {
      const sy = y * scaleY;
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, ny - 1);
      const wy = sy - y0;
      for (let x = 0; x < nnx; x++) {
        const sx = x * scaleX;
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = sx - x0;
        const c000 = data[x0 + y0*nx + z0*nx*ny];
        const c100 = data[x1 + y0*nx + z0*nx*ny];
        const c010 = data[x0 + y1*nx + z0*nx*ny];
        const c110 = data[x1 + y1*nx + z0*nx*ny];
        const c001 = data[x0 + y0*nx + z1*nx*ny];
        const c101 = data[x1 + y0*nx + z1*nx*ny];
        const c011 = data[x0 + y1*nx + z1*nx*ny];
        const c111 = data[x1 + y1*nx + z1*nx*ny];
        const c00 = c000*(1-wx) + c100*wx;
        const c10 = c010*(1-wx) + c110*wx;
        const c01 = c001*(1-wx) + c101*wx;
        const c11 = c011*(1-wx) + c111*wx;
        result[x + y*nnx + z*nnx*nny] = (c00*(1-wy) + c10*wy)*(1-wz) + (c01*(1-wy) + c11*wy)*wz;
      }
    }
  }
  return { data: result, dims: newDims };
}

function resampleLabelsNearest(data, dims, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);
  for (let z = 0; z < tnz; z++) {
    const sz = Math.min(Math.max(0, Math.floor((z + 0.5) * nz / tnz)), nz - 1);
    for (let y = 0; y < tny; y++) {
      const sy = Math.min(Math.max(0, Math.floor((y + 0.5) * ny / tny)), ny - 1);
      for (let x = 0; x < tnx; x++) {
        const sx = Math.min(Math.max(0, Math.floor((x + 0.5) * nx / tnx)), nx - 1);
        result[x + y*tnx + z*tnx*tny] = data[sx + sy*nx + sz*nx*ny];
      }
    }
  }
  return result;
}

function transposeXYZToZYX(data, dims, OutputCtor) {
  const [nx, ny, nz] = dims;
  const result = new (OutputCtor || Float32Array)(data.length);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        result[z + y*nz + x*nz*ny] = data[x + y*nx + z*nx*ny];
  return { data: result, dims: [nz, ny, nx] };
}

function transposeZYXToXYZ(data, dims, OutputCtor) {
  const [nz, ny, nx] = dims;
  const result = new (OutputCtor || Uint8Array)(data.length);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        result[x + y*nx + z*nx*ny] = data[z + y*nz + x*nz*ny];
  return { data: result, dims: [nx, ny, nz] };
}

async function runCase(fixture) {
  const inputPath = path.join(ROOT, fixture.inputPath);
  const outPath = path.join(path.dirname(inputPath), 'browser_output.nii.gz');
  const { taskId, asset } = resolveTaskAsset(fixture.id);
  const modelPath = path.join(ROOT, 'web/models', asset.filename);

  const { header, dims, data } = readNiftiRaw(inputPath);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const spacing = [headerView.getFloat32(80, true), headerView.getFloat32(84, true), headerView.getFloat32(88, true)].map(v => Math.abs(v) || 1);
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

  let modelInputData = data;
  let modelInputDims = dims;
  let modelOutputToInput = (labels, labelDims) => ({ labels, dims: labelDims });
  if (Array.isArray(asset.preprocessing?.targetSpacing)) {
    const targetSpacing = asset.preprocessing.targetSpacing.map((value, index) => value == null ? spacing[index] : Number(value));
    const resampled = resampleVolume(modelInputData, modelInputDims, spacing, targetSpacing);
    modelInputData = resampled.data;
    modelInputDims = resampled.dims;
    const previous = modelOutputToInput;
    modelOutputToInput = (labels, labelDims) => {
      const restored = previous(labels, labelDims);
      return { labels: resampleLabelsNearest(restored.labels, restored.dims, dims), dims };
    };
  }
  if (asset.preprocessing?.modelAxisOrder === 'zyx') {
    const transposed = transposeXYZToZYX(modelInputData, modelInputDims, Float32Array);
    modelInputData = transposed.data;
    modelInputDims = transposed.dims;
    const previous = modelOutputToInput;
    modelOutputToInput = (labels, labelDims) => {
      const restoredAxes = transposeZYXToXYZ(labels, labelDims, Uint8Array);
      return previous(restoredAxes.data, restoredAxes.dims);
    };
  }

  const result = await pipeline.runInferencePipeline(
    { data: modelInputData, dims: modelInputDims, patchSize },
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

  const restored = modelOutputToInput(result.labels, result.dims);
  writeUint8NiftiGz(outPath, header, dims, restored.labels);

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
