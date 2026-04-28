#!/usr/bin/env node
/**
 * End-to-end test of web/js/inference-worker.js against the dmri fixture.
 *
 * Loads the worker source as text, evaluates it in a Node context with shimmed
 * globals (self/importScripts/fetch/localforage/ort/nifti), then drives it via
 * a synthetic message and asserts the produced segmentation is non-empty.
 *
 * Catches the regression class: changes to inference-worker.js preprocessing,
 * patching, or post-processing that silently produce empty/degenerate outputs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ort = require('onnxruntime-node');
const nifti = require(path.resolve(__dirname, '../web/nifti-js/index.js'));

const ROOT = path.resolve(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'web/js/inference-worker.js');
const MODEL_PATH = path.join(ROOT, 'web/models/sct-spinalcord.onnx');
const FIXTURE_INPUT = path.join(ROOT, 'test_data/batch_dmri_deepseg_spinalcord/input.nii.gz');
const FIXTURE_BATCH_OUTPUT = path.join(ROOT, 'test_data/batch_dmri_deepseg_spinalcord/batch_output.nii.gz');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function loadFixtureForeground(filePath) {
  const compressed = fs.readFileSync(filePath);
  const zlib = require('node:zlib');
  const bytes = filePath.endsWith('.gz') ? zlib.gunzipSync(compressed) : compressed;
  if (bytes.readInt32LE(0) !== 348) throw new Error(`Only NIfTI-1: ${filePath}`);
  const datatype = bytes.readInt16LE(70);
  const voxOffset = Math.ceil(bytes.readFloatLE(108));
  const dims = [bytes.readInt16LE(42), bytes.readInt16LE(44), bytes.readInt16LE(46)];
  const n = dims[0] * dims[1] * dims[2];
  let fg = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (datatype === 2) v = bytes[voxOffset + i];
    else if (datatype === 4) v = bytes.readInt16LE(voxOffset + i * 2);
    else if (datatype === 16) v = bytes.readFloatLE(voxOffset + i * 4);
    if (v > 0) fg++;
  }
  return { dims, fg };
}

// Build an ort shim that maps onnxruntime-web API surface to onnxruntime-node.
function makeOrtShim() {
  return {
    Tensor: ort.Tensor,
    InferenceSession: {
      create: async (data /* ArrayBuffer */, _opts) => {
        // onnxruntime-node accepts Buffer or path; convert ArrayBuffer to Buffer
        const buf = Buffer.from(data);
        const session = await ort.InferenceSession.create(buf, { executionProviders: ['cpu'] });
        return session;
      }
    },
    env: {
      wasm: { numThreads: 1, wasmPaths: '' }
    }
  };
}

// Minimal localforage shim: in-memory Map.
function makeLocalforageShim() {
  const store = new Map();
  return {
    config: () => {},
    getItem: async (key) => store.has(key) ? store.get(key) : null,
    setItem: async (key, value) => { store.set(key, value); },
    removeItem: async (key) => { store.delete(key); }
  };
}

// Fetch shim: reads MODEL_PATH from disk for any model URL.
function makeFetchShim() {
  return async (url) => {
    if (!url.endsWith('.onnx')) throw new Error(`Unexpected fetch: ${url}`);
    const buffer = fs.readFileSync(MODEL_PATH);
    let offset = 0;
    return {
      ok: true,
      headers: { get: (name) => name === 'content-length' ? String(buffer.length) : null },
      body: {
        getReader: () => ({
          read: async () => {
            if (offset >= buffer.length) return { done: true, value: undefined };
            const chunk = buffer.subarray(offset, Math.min(offset + 1024 * 1024, buffer.length));
            offset += chunk.length;
            return { done: false, value: new Uint8Array(chunk) };
          }
        })
      }
    };
  };
}

async function main() {
  console.log('Loading worker source...');
  const workerSource = fs.readFileSync(WORKER_PATH, 'utf8');

  const messages = [];
  let resolveDone, rejectDone;
  const donePromise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  // Build the sandbox `self` (also exposed as global).
  const selfObj = {
    onmessage: null,
    postMessage: (msg /*, transferList */) => {
      messages.push(msg);
      if (msg && msg.type === 'error') rejectDone(new Error(msg.message));
      if (msg && msg.type === 'complete') resolveDone();
    },
    _modelCacheKey: null,
    _appVersion: 'test',
    _currentTaskId: null
  };

  const sandbox = {
    self: selfObj,
    // External scripts (ort/localforage/nifti, the wasm bundle) are pre-shimmed
    // via context globals, so we ignore those importScripts calls. For local
    // pipeline modules we evaluate the file so its UMD bootstrap registers on `self`.
    importScripts: (relPath) => {
      if (typeof relPath !== 'string') return;
      // Only load the inference-pipeline sibling; everything else is shimmed.
      if (!/inference-pipeline\.js$/.test(relPath)) return;
      const abs = path.resolve(path.dirname(WORKER_PATH), relPath);
      if (!fs.existsSync(abs)) return;
      const src = fs.readFileSync(abs, 'utf8');
      vm.runInContext(src, sandbox, { filename: abs });
      // The pipeline UMD bootstrap assigns to `root.SCTInferencePipeline`
      // where root === self in worker context. In our vm sandbox, `self` is a
      // sandbox property (not the global itself), so promote the export to a
      // bare global so bare-name references in inference-worker.js resolve.
      if (selfObj.SCTInferencePipeline) {
        sandbox.SCTInferencePipeline = selfObj.SCTInferencePipeline;
      }
    },
    ort: makeOrtShim(),
    localforage: makeLocalforageShim(),
    nifti,
    fetch: makeFetchShim(),
    performance: { now: () => Date.now() },
    console,
    Math,
    Number,
    Array,
    Uint8Array,
    Uint16Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    ArrayBuffer,
    SharedArrayBuffer,
    Buffer,
    Object,
    String,
    Boolean,
    Promise,
    Set,
    Map,
    Symbol,
    Error,
    TypeError,
    RangeError,
    Infinity,
    NaN,
    URL,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    setTimeout,
    clearTimeout,
    setImmediate,
    queueMicrotask,
    navigator: { hardwareConcurrency: 1 },
    location: { href: 'http://localhost/' }
  };

  vm.createContext(sandbox);
  // Make selfObj fields also accessible as bare globals (worker uses both `self.x` and bare names).
  sandbox.globalThis = sandbox;

  console.log('Evaluating worker source...');
  vm.runInContext(workerSource, sandbox, { filename: 'inference-worker.js' });

  if (typeof selfObj.onmessage !== 'function') {
    fail('worker did not register self.onmessage');
  }

  console.log('Loading fixture input...');
  const inputBytes = fs.readFileSync(FIXTURE_INPUT);
  // Wrap into an ArrayBuffer view that the worker's parser expects.
  const inputArrayBuffer = inputBytes.buffer.slice(inputBytes.byteOffset, inputBytes.byteOffset + inputBytes.byteLength);

  console.log('Driving worker: init -> run...');
  // init
  await selfObj.onmessage({ data: { type: 'init', version: 'test' } });

  // legacy 'run' message: stepLoad + stepInference in one go
  selfObj.onmessage({
    data: {
      type: 'run',
      data: {
        inputData: inputArrayBuffer,
        settings: {
          overlap: 0,
          taskId: 'spinalcord',
          modelAssetId: 'sct-spinalcord',
          supportStatus: 'supported',
          cacheKey: 'spinalcord:sct-spinalcord:stable',
          provenance: { taskId: 'spinalcord', appVersion: 'test' },
          probabilityThreshold: 0.5,
          minComponentSize: 10,
          modelName: 'sct-spinalcord.onnx',
          patchSize: [160, 224, 64],
          testTimeAugmentation: false, // turn off TTA for speed; bug is independent of TTA
          modelBaseUrl: 'http://localhost/web/models'
        }
      }
    }
  }).catch(rejectDone);

  // Watchdog
  const timeout = setTimeout(() => rejectDone(new Error('worker did not complete in 5min')), 5 * 60 * 1000);
  await donePromise;
  clearTimeout(timeout);

  // Find the segmentation stage data
  const stageMsg = messages.find(m => m && m.type === 'stageData' && m.stage === 'segmentation');
  if (!stageMsg) fail('worker did not emit segmentation stageData');

  // Decode the produced NIfTI to count foreground voxels.
  const niftiBytes = stageMsg.niftiData instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(stageMsg.niftiData))
    : Buffer.from(stageMsg.niftiData.buffer || stageMsg.niftiData);
  // Worker writes uint8 datatype=2, no gzip; parse directly.
  const datatype = niftiBytes.readInt16LE(70);
  const voxOffset = Math.ceil(niftiBytes.readFloatLE(108));
  const dims = [niftiBytes.readInt16LE(42), niftiBytes.readInt16LE(44), niftiBytes.readInt16LE(46)];
  const n = dims[0] * dims[1] * dims[2];
  if (datatype !== 2) fail(`expected uint8 segmentation output, got datatype=${datatype}`);
  let producedFg = 0;
  for (let i = 0; i < n; i++) if (niftiBytes[voxOffset + i] > 0) producedFg++;

  const expected = loadFixtureForeground(FIXTURE_BATCH_OUTPUT);

  console.log(`Produced foreground voxels: ${producedFg}`);
  console.log(`SCT batch reference foreground voxels: ${expected.fg}`);
  console.log(`Output dims: ${dims.join('x')}, expected dims: ${expected.dims.join('x')}`);

  if (producedFg === 0) fail('worker produced empty segmentation (regression: stretch-to-patch destroying anatomy?)');
  if (producedFg < expected.fg * 0.5 || producedFg > expected.fg * 1.5) {
    fail(`worker foreground count ${producedFg} differs from SCT batch reference ${expected.fg} by >50%`);
  }
  if (dims[0] !== expected.dims[0] || dims[1] !== expected.dims[1] || dims[2] !== expected.dims[2]) {
    fail(`output dims ${dims.join('x')} != expected ${expected.dims.join('x')}`);
  }

  console.log('PASS: inference-worker e2e on dmri fixture');
}

main().catch((err) => {
  console.error('Test crashed:', err && err.stack || err);
  process.exit(1);
});
