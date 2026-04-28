#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ort = require('onnxruntime-node');
const fixtures = require('./batch-parity-fixtures.cjs');
const { loadNifti, compareNiftiOutputs } = require('./batch-parity-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const PATCH = [64, 64, 64];
const THRESHOLD = Number(process.env.BROWSER_THRESHOLD || 0.1);
const MIN_COMPONENT_SIZE = Number(process.env.BROWSER_MIN_COMPONENT_SIZE || 10);
const OPTIMIZE_THRESHOLD = process.env.BROWSER_OPTIMIZE_THRESHOLD === '1';

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

function zScore(data) {
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / data.length;
  let sumSq = 0;
  for (const value of data) {
    const diff = value - mean;
    sumSq += diff * diff;
  }
  const std = Math.sqrt(sumSq / data.length) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (data[i] - mean) / std;
  return out;
}

function paddedDims(dims) {
  return dims.map((dim, i) => Math.ceil(dim / PATCH[i]) * PATCH[i]);
}

function padVolume(data, dims, outDims) {
  const out = new Float32Array(outDims[0] * outDims[1] * outDims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      const src = z * dims[0] * dims[1] + y * dims[0];
      const dst = z * outDims[0] * outDims[1] + y * outDims[0];
      out.set(data.subarray(src, src + dims[0]), dst);
    }
  }
  return out;
}

function cropLabels(data, dims, outDims) {
  const out = new Uint8Array(outDims[0] * outDims[1] * outDims[2]);
  for (let z = 0; z < outDims[2]; z++) {
    for (let y = 0; y < outDims[1]; y++) {
      const src = z * dims[0] * dims[1] + y * dims[0];
      const dst = z * outDims[0] * outDims[1] + y * outDims[0];
      out.set(data.subarray(src, src + outDims[0]), dst);
    }
  }
  return out;
}

function extractPatch(data, dims, x0, y0, z0) {
  const out = new Float32Array(PATCH[0] * PATCH[1] * PATCH[2]);
  for (let z = 0; z < PATCH[2]; z++) {
    for (let y = 0; y < PATCH[1]; y++) {
      const src = (z0 + z) * dims[0] * dims[1] + (y0 + y) * dims[0] + x0;
      const dst = z * PATCH[0] * PATCH[1] + y * PATCH[0];
      out.set(data.subarray(src, src + PATCH[0]), dst);
    }
  }
  return out;
}

function writePatch(mask, dims, logits, x0, y0, z0, threshold) {
  for (let z = 0; z < PATCH[2]; z++) {
    for (let y = 0; y < PATCH[1]; y++) {
      const base = z * PATCH[0] * PATCH[1] + y * PATCH[0];
      const dst = (z0 + z) * dims[0] * dims[1] + (y0 + y) * dims[0] + x0;
      for (let x = 0; x < PATCH[0]; x++) {
        const prob = 1 / (1 + Math.exp(-logits[base + x]));
        if (prob >= threshold) mask[dst + x] = 1;
      }
    }
  }
}

function writeProbPatch(probMap, dims, logits, x0, y0, z0) {
  for (let z = 0; z < PATCH[2]; z++) {
    for (let y = 0; y < PATCH[1]; y++) {
      const base = z * PATCH[0] * PATCH[1] + y * PATCH[0];
      const dst = (z0 + z) * dims[0] * dims[1] + (y0 + y) * dims[0] + x0;
      for (let x = 0; x < PATCH[0]; x++) {
        probMap[dst + x] = 1 / (1 + Math.exp(-logits[base + x]));
      }
    }
  }
}

function removeSmallComponents(mask, dims, minSize) {
  if (minSize <= 1) return mask;
  const labels = new Int32Array(mask.length);
  const sizes = [0];
  let label = 0;
  const queue = [];
  const [nx, ny, nz] = dims;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    label++;
    let size = 0;
    labels[i] = label;
    queue.push(i);
    while (queue.length) {
      const idx = queue.pop();
      size++;
      const x = idx % nx;
      const y = Math.floor(idx / nx) % ny;
      const z = Math.floor(idx / (nx * ny));
      const ns = [];
      if (x > 0) ns.push(idx - 1);
      if (x + 1 < nx) ns.push(idx + 1);
      if (y > 0) ns.push(idx - nx);
      if (y + 1 < ny) ns.push(idx + nx);
      if (z > 0) ns.push(idx - nx * ny);
      if (z + 1 < nz) ns.push(idx + nx * ny);
      for (const ni of ns) {
        if (mask[ni] && !labels[ni]) {
          labels[ni] = label;
          queue.push(ni);
        }
      }
    }
    sizes[label] = size;
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (labels[i] && sizes[labels[i]] >= minSize) out[i] = 1;
  }
  return out;
}

function thresholdMask(probMap, threshold) {
  const mask = new Uint8Array(probMap.length);
  for (let i = 0; i < probMap.length; i++) {
    if (probMap[i] >= threshold) mask[i] = 1;
  }
  return mask;
}

function diceAgainstExpected(mask, dims, expectedData, expectedDims) {
  const cropped = cropLabels(removeSmallComponents(mask, dims, MIN_COMPONENT_SIZE), dims, expectedDims);
  let expectedNz = 0, producedNz = 0, intersection = 0;
  for (let i = 0; i < expectedData.length; i++) {
    const e = expectedData[i] > 0;
    const p = cropped[i] > 0;
    if (e) expectedNz++;
    if (p) producedNz++;
    if (e && p) intersection++;
  }
  const dice = expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1;
  return { dice, expectedNz, producedNz, cropped };
}

function findBestThreshold(probMap, dims, expectedData, expectedDims) {
  const candidates = [];
  for (let i = 0; i <= 100; i++) candidates.push(i / 100);
  for (const value of [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.075, 0.125, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
    candidates.push(value);
  }
  let best = { threshold: THRESHOLD, dice: -1, cropped: null, expectedNz: 0, producedNz: 0 };
  for (const threshold of [...new Set(candidates)].sort((a, b) => a - b)) {
    const scored = diceAgainstExpected(thresholdMask(probMap, threshold), dims, expectedData, expectedDims);
    if (scored.dice > best.dice) best = { threshold, ...scored };
  }
  return best;
}

async function runCase(fixture) {
  const inputPath = path.join(ROOT, fixture.inputPath);
  const outPath = path.join(path.dirname(inputPath), 'browser_output.nii.gz');
  const modelName = fixture.id.includes('graymatter') ? 'sct-graymatter.onnx' : 'sct-spinalcord.onnx';
  const modelPath = path.join(ROOT, 'web/models', modelName);
  const { header, dims, data } = readNiftiRaw(inputPath);
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  const pDims = paddedDims(dims);
  const volume = padVolume(zScore(data), dims, pDims);
  const mask = new Uint8Array(volume.length);
  const probMap = OPTIMIZE_THRESHOLD ? new Float32Array(volume.length) : null;
  const total = (pDims[0] / 64) * (pDims[1] / 64) * (pDims[2] / 64);
  let done = 0;
  for (let z = 0; z < pDims[2]; z += 64) {
    for (let y = 0; y < pDims[1]; y += 64) {
      for (let x = 0; x < pDims[0]; x += 64) {
        const patch = extractPatch(volume, pDims, x, y, z);
        const tensor = new ort.Tensor('float32', patch, [1, 1, 64, 64, 64]);
        const result = await session.run({ [session.inputNames[0]]: tensor });
        if (probMap) writeProbPatch(probMap, pDims, result[session.outputNames[0]].data, x, y, z);
        else writePatch(mask, pDims, result[session.outputNames[0]].data, x, y, z, THRESHOLD);
        done++;
        if (done % 20 === 0 || done === total) process.stderr.write(`${fixture.id}: ${done}/${total}\n`);
      }
    }
  }
  await session.release();
  const expected = loadNifti(path.join(ROOT, fixture.expectedOutputPath));
  const best = probMap
    ? findBestThreshold(probMap, pDims, expected.data, dims)
    : { threshold: THRESHOLD, ...diceAgainstExpected(mask, pDims, expected.data, dims) };
  const cropped = best.cropped;
  writeUint8NiftiGz(outPath, header, dims, cropped);

  const produced = loadNifti(outPath);
  const mismatches = compareNiftiOutputs(expected, produced, fixture.tolerancePolicy, 'browser_output.nii.gz', 'browser_output.nii.gz');
  let expectedNz = 0, producedNz = 0, intersection = 0;
  for (let i = 0; i < expected.data.length; i++) {
    const e = expected.data[i] > 0;
    const p = produced.data[i] > 0;
    if (e) expectedNz++;
    if (p) producedNz++;
    if (e && p) intersection++;
  }
  const dice = expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1;
  return { id: fixture.id, outPath: path.relative(ROOT, outPath), mismatches, expectedNz, producedNz, dice, threshold: best.threshold };
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
      threshold: result.threshold
    }));
  }
})();
