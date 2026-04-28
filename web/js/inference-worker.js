/**
 * SpinalCordToolbox Inference Worker
 *
 * Runs ONNX model inference for 3D patch-based SCT segmentation.
 * Pipeline is split into interactive steps:
 *   1. Load (NIfTI parse + orient to RAS)
 *   2. Inference (resample → normalize → crop → sliding window → threshold → CC → inverse)
 */

/* global importScripts, ort, localforage, nifti, wasm_bindgen */

importScripts('../wasm/ort.webgpu.min.js');
importScripts('https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js');
importScripts('../nifti-js/index.js');

// Preprocessing WASM (optional - loaded if available)
let wasmPreprocessingAvailable = false;
try {
  importScripts('../preprocessing-wasm/preprocessing.js');
  wasmPreprocessingAvailable = true;
} catch (e) {
  console.warn('Preprocessing WASM import failed:', e);
}

const FIXED_TARGET_SPACING = [0.3, 0.3, 0.3];
const MAX_PROCESSING_VOXELS = 100 * 1024 * 1024;

// ==================== Shared Worker State ====================

let workerState = {
  headerBytes: null,
  origHeaderBytes: null,
  origDims: null,
  affine: null,
  perm: null,
  flip: null,
  isIdentity: null,
  rasData: null,
  rasDims: null,
  rasSpacing: null,
  brainMask: null,
  denoisedData: null,
  // Unmasked segmentation labels in RAS space (before brain mask / CC cleanup)
  segLabelsRAS: null,
  segMinComponentSize: 10,
};

function resetState() {
  workerState = {
    headerBytes: null,
    origHeaderBytes: null,
    origDims: null,
    affine: null,
    perm: null,
    flip: null,
    isIdentity: null,
    rasData: null,
    rasDims: null,
    rasSpacing: null,
    brainMask: null,
    denoisedData: null,
    segLabelsRAS: null,
    segMinComponentSize: 10,
  };
}

// ==================== Message Helpers ====================

function postProgress(value, text) {
  self.postMessage({ type: 'progress', value, text });
}

function postLog(message) {
  self.postMessage({ type: 'log', message });
}

function postError(message) {
  self.postMessage({ type: 'error', message });
}

function postComplete() {
  self.postMessage({ type: 'complete' });
}

function postStageData(stage, niftiData, description) {
  self.postMessage(
    { type: 'stageData', stage, niftiData, description, taskId: self._currentTaskId || 'spinalcord' },
    [niftiData]
  );
}

function postStepComplete(step) {
  self.postMessage({ type: 'step-complete', step });
}

function postVolumeInfo(info) {
  self.postMessage({ type: 'volume-info', ...info });
}

function collectTransferables(value, transferables, seen = new Set()) {
  if (!value || typeof value !== 'object') return;

  if (value instanceof ArrayBuffer) {
    if (!seen.has(value)) {
      seen.add(value);
      transferables.push(value);
    }
    return;
  }

  if (ArrayBuffer.isView(value)) {
    collectTransferables(value.buffer, transferables, seen);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, transferables, seen);
    return;
  }

  for (const nestedValue of Object.values(value)) {
    collectTransferables(nestedValue, transferables, seen);
  }
}

function postStateArtifact(artifact, payload) {
  const transferables = [];
  collectTransferables(payload, transferables);
  self.postMessage({ type: 'state-artifact', artifact, payload }, transferables);
}

function emitSegmentationStateArtifact() {
  const segLabelsRAS = workerState.segLabelsRAS ? new Uint8Array(workerState.segLabelsRAS).buffer : null;
  postStateArtifact('segmentationState', {
    segLabelsRAS,
    segMinComponentSize: workerState.segMinComponentSize ?? 10
  });
}

// ==================== NIfTI Parsing ====================

function decompressIfNeeded(data) {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof nifti !== 'undefined' && nifti.isCompressed) {
      if (nifti.isCompressed(bytes.buffer)) {
        return new Uint8Array(nifti.decompress(bytes.buffer));
      }
    }
    throw new Error('Gzipped NIfTI detected but decompression not available');
  }
  return bytes;
}

function parseNiftiInput(arrayBuffer) {
  const data = decompressIfNeeded(arrayBuffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const dims = [];
  for (let i = 0; i < 8; i++) dims.push(view.getInt16(40 + i * 2, true));
  const nx = dims[1], ny = dims[2], nz = dims[3];

  const pixDims = [];
  for (let i = 0; i < 8; i++) pixDims.push(view.getFloat32(76 + i * 4, true));

  const datatype = view.getInt16(70, true);
  const voxOffset = view.getFloat32(108, true);
  const sclSlope = view.getFloat32(112, true) || 1;
  const sclInter = view.getFloat32(116, true) || 0;
  const dataStart = Math.ceil(voxOffset);
  const nTotal = nx * ny * nz;

  const imageData = new Float32Array(nTotal);
  switch (datatype) {
    case 2:
      for (let i = 0; i < nTotal; i++) imageData[i] = data[dataStart + i] * sclSlope + sclInter;
      break;
    case 4:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getInt16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    case 8:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getInt32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 16:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getFloat32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 64:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getFloat64(dataStart + i * 8, true) * sclSlope + sclInter;
      break;
    case 512:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getUint16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }

  const affine = extractAffine(view);

  const headerSize = dataStart;
  const headerBytes = new ArrayBuffer(headerSize);
  new Uint8Array(headerBytes).set(data.slice(0, headerSize));

  return {
    imageData,
    dims: [nx, ny, nz],
    voxelSize: [Math.abs(pixDims[1]) || 1, Math.abs(pixDims[2]) || 1, Math.abs(pixDims[3]) || 1],
    headerBytes,
    affine
  };
}

function extractAffine(view) {
  const sformCode = view.getInt16(254, true);
  const qformCode = view.getInt16(252, true);

  if (sformCode > 0) {
    const affine = [new Float64Array(4), new Float64Array(4), new Float64Array(4), new Float64Array([0, 0, 0, 1])];
    for (let i = 0; i < 4; i++) {
      affine[0][i] = view.getFloat32(280 + i * 4, true);
      affine[1][i] = view.getFloat32(296 + i * 4, true);
      affine[2][i] = view.getFloat32(312 + i * 4, true);
    }
    return affine;
  }

  if (qformCode > 0) {
    const pixDims = [];
    for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
    const qb = view.getFloat32(256, true);
    const qc = view.getFloat32(260, true);
    const qd = view.getFloat32(264, true);
    const qx = view.getFloat32(268, true);
    const qy = view.getFloat32(272, true);
    const qz = view.getFloat32(276, true);
    const sqr = qb * qb + qc * qc + qd * qd;
    const qa = sqr > 1.0 ? 0.0 : Math.sqrt(1.0 - sqr);
    const R = [
      [qa*qa+qb*qb-qc*qc-qd*qd, 2*(qb*qc-qa*qd), 2*(qb*qd+qa*qc)],
      [2*(qb*qc+qa*qd), qa*qa+qc*qc-qb*qb-qd*qd, 2*(qc*qd-qa*qb)],
      [2*(qb*qd-qa*qc), 2*(qc*qd+qa*qb), qa*qa+qd*qd-qb*qb-qc*qc]
    ];
    const qfac = pixDims[0] < 0 ? -1 : 1;
    return [
      new Float64Array([R[0][0]*pixDims[1], R[0][1]*pixDims[2], R[0][2]*pixDims[3]*qfac, qx]),
      new Float64Array([R[1][0]*pixDims[1], R[1][1]*pixDims[2], R[1][2]*pixDims[3]*qfac, qy]),
      new Float64Array([R[2][0]*pixDims[1], R[2][1]*pixDims[2], R[2][2]*pixDims[3]*qfac, qz]),
      new Float64Array([0, 0, 0, 1])
    ];
  }

  const pixDims = [];
  for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
  return [
    new Float64Array([pixDims[1] || 1, 0, 0, 0]),
    new Float64Array([0, pixDims[2] || 1, 0, 0]),
    new Float64Array([0, 0, pixDims[3] || 1, 0]),
    new Float64Array([0, 0, 0, 1])
  ];
}

// ==================== NIfTI Output ====================

function createOutputNifti(uint8Data, sourceHeader, dims) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const buffer = new ArrayBuffer(headerSize + uint8Data.length);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Set datatype to UINT8
  destView.setInt16(70, 2, true);
  destView.setInt16(72, 8, true);

  // Update dims if provided
  if (dims) {
    destView.setInt16(40, 3, true);
    destView.setInt16(42, dims[0], true);
    destView.setInt16(44, dims[1], true);
    destView.setInt16(46, dims[2], true);
    destView.setInt16(48, 1, true);
  }

  destView.setFloat32(112, 1, true);  // scl_slope
  destView.setFloat32(116, 0, true);  // scl_inter

  // cal_min/cal_max for binary mask
  destView.setFloat32(124, 1, true);   // cal_max
  destView.setFloat32(128, 0, true);   // cal_min

  new Uint8Array(buffer, headerSize).set(uint8Data);
  return buffer;
}

function createFloat32Nifti(float32Data, sourceHeader, dims, spacing) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const dataBytes = float32Data.length * 4;
  const buffer = new ArrayBuffer(headerSize + dataBytes);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Set datatype to FLOAT32
  destView.setInt16(70, 16, true);
  destView.setInt16(72, 32, true);

  if (dims) {
    destView.setInt16(40, 3, true);
    destView.setInt16(42, dims[0], true);
    destView.setInt16(44, dims[1], true);
    destView.setInt16(46, dims[2], true);
    destView.setInt16(48, 1, true);
  }

  if (spacing) {
    destView.setFloat32(80, spacing[0], true);  // pixdim[1]
    destView.setFloat32(84, spacing[1], true);  // pixdim[2]
    destView.setFloat32(88, spacing[2], true);  // pixdim[3]
  }

  destView.setFloat32(112, 1, true);  // scl_slope
  destView.setFloat32(116, 0, true);  // scl_inter

  // cal_min/cal_max: auto range
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < float32Data.length; i++) {
    if (float32Data[i] < minVal) minVal = float32Data[i];
    if (float32Data[i] > maxVal) maxVal = float32Data[i];
  }
  destView.setFloat32(124, maxVal, true);  // cal_max
  destView.setFloat32(128, minVal, true);  // cal_min

  new Uint8Array(buffer, headerSize).set(new Uint8Array(float32Data.buffer, float32Data.byteOffset, dataBytes));
  return buffer;
}

// ==================== Preprocessing ====================

function getOrientationTransform(affine) {
  const mat = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]]
  ];

  const perm = [0, 0, 0];
  const flip = [false, false, false];
  const used = [false, false, false];

  for (let outAxis = 0; outAxis < 3; outAxis++) {
    let bestAxis = -1;
    let bestVal = -1;
    for (let inAxis = 0; inAxis < 3; inAxis++) {
      if (used[inAxis]) continue;
      const val = Math.abs(mat[outAxis][inAxis]);
      if (val > bestVal) {
        bestVal = val;
        bestAxis = inAxis;
      }
    }
    perm[outAxis] = bestAxis;
    flip[outAxis] = mat[outAxis][bestAxis] < 0;
    used[bestAxis] = true;
  }

  return { perm, flip };
}

function orientToRAS(data, dims, perm, flip) {
  const [nx, ny, nz] = dims;
  const srcDims = [nx, ny, nz];
  const dstDims = [srcDims[perm[0]], srcDims[perm[1]], srcDims[perm[2]]];
  const [dx, dy, dz] = dstDims;
  const result = new Float32Array(dx * dy * dz);

  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dstDims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = src[0] + src[1] * nx + src[2] * nx * ny;
        const dstIdx = ox + oy * dx + oz * dx * dy;
        result[dstIdx] = data[srcIdx];
      }
    }
  }

  return { data: result, dims: dstDims };
}

function padToPatchMultiple(data, dims, patchSize) {
  const [nx, ny, nz] = dims;
  const [px, py, pz] = Array.isArray(patchSize) ? patchSize : [patchSize, patchSize, patchSize];
  const pad = (d, p) => d > p && d % p !== 0 ? Math.ceil(d / p) * p : d < p ? p : d;
  const nnx = pad(nx, px);
  const nny = pad(ny, py);
  const nnz = pad(nz, pz);

  if (nnx === nx && nny === ny && nnz === nz) {
    return { data, dims: [nx, ny, nz] };
  }

  // Nearest-neighbor resize matching scipy.ndimage.zoom(order=0, mode='nearest')
  // scipy uses half-pixel center mapping: source = floor((output + 0.5) * inputSize / outputSize)
  const result = new Float32Array(nnx * nny * nnz);

  for (let z = 0; z < nnz; z++) {
    const sz = Math.min(Math.max(0, Math.floor((z + 0.5) * nz / nnz)), nz - 1);
    for (let y = 0; y < nny; y++) {
      const sy = Math.min(Math.max(0, Math.floor((y + 0.5) * ny / nny)), ny - 1);
      for (let x = 0; x < nnx; x++) {
        const sx = Math.min(Math.max(0, Math.floor((x + 0.5) * nx / nnx)), nx - 1);
        result[x + y * nnx + z * nnx * nny] = data[sx + sy * nx + sz * nx * ny];
      }
    }
  }

  return { data: result, dims: [nnx, nny, nnz] };
}

/**
 * Zero-pad volume so each dimension is a multiple of patchSize.
 * Unlike padToPatchMultiple (which resizes), this preserves voxel spacing.
 */
function zeroPadToPatchMultiple(data, dims, patchSize) {
  const [nx, ny, nz] = dims;
  const [px, py, pz] = Array.isArray(patchSize) ? patchSize : [patchSize, patchSize, patchSize];
  const pad = (d, p) => d > p && d % p !== 0 ? Math.ceil(d / p) * p : d < p ? p : d;
  const nnx = pad(nx, px);
  const nny = pad(ny, py);
  const nnz = pad(nz, pz);

  if (nnx === nx && nny === ny && nnz === nz) {
    return { data, dims: [nx, ny, nz] };
  }

  const result = new Float32Array(nnx * nny * nnz); // initialized to 0
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        result[x + y * nnx + z * nnx * nny] = data[x + y * nx + z * nx * ny];
      }
    }
  }

  return { data: result, dims: [nnx, nny, nnz] };
}

/**
 * Remove zero-padding: crop a volume back to target dimensions.
 */
function unpadVolume(data, dims, tgtDims, OutputCtor = Uint8Array) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new OutputCtor(tnx * tny * tnz);
  for (let z = 0; z < tnz; z++) {
    for (let y = 0; y < tny; y++) {
      for (let x = 0; x < tnx; x++) {
        result[x + y * tnx + z * tnx * tny] = data[x + y * nx + z * nx * ny];
      }
    }
  }
  return result;
}

function computeResampledDims(dims, srcSpacing, tgtSpacing) {
  return [
    Math.max(1, Math.round(dims[0] * srcSpacing[0] / tgtSpacing[0])),
    Math.max(1, Math.round(dims[1] * srcSpacing[1] / tgtSpacing[1])),
    Math.max(1, Math.round(dims[2] * srcSpacing[2] / tgtSpacing[2]))
  ];
}

function resampleVolume(data, dims, srcSpacing, tgtSpacing) {
  const [nx, ny, nz] = dims;
  const newDims = computeResampledDims(dims, srcSpacing, tgtSpacing);
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
        const c01 = c001*(1-wx) + c101*wx;
        const c10 = c010*(1-wx) + c110*wx;
        const c11 = c011*(1-wx) + c111*wx;
        const c0 = c00*(1-wy) + c10*wy;
        const c1 = c01*(1-wy) + c11*wy;

        result[x + y*nnx + z*nnx*nny] = c0*(1-wz) + c1*wz;
      }
    }
  }

  return { data: result, dims: newDims, spacing: tgtSpacing };
}

function extractSliceRange(data, dims, startZ, endZ, outputCtor = Float32Array) {
  const [nx, ny, nz] = dims;
  const clampedStart = Math.max(0, Math.min(nz, Math.floor(startZ)));
  const clampedEnd = Math.max(clampedStart, Math.min(nz, Math.floor(endZ)));
  const subsetNz = clampedEnd - clampedStart;
  const sliceSize = nx * ny;
  const result = new outputCtor(sliceSize * subsetNz);
  for (let z = 0; z < subsetNz; z++) {
    const srcOff = (clampedStart + z) * sliceSize;
    const dstOff = z * sliceSize;
    result.set(data.subarray(srcOff, srcOff + sliceSize), dstOff);
  }
  return { data: result, dims: [nx, ny, subsetNz] };
}

function embedSliceSubsection(data, subsectionDims, fullDims, startZ) {
  const [nx, ny, nz] = subsectionDims;
  const [fnx, fny, fnz] = fullDims;
  if (nx !== fnx || ny !== fny) {
    throw new Error('Subsection and full dimensions are incompatible for embedding');
  }
  if (startZ < 0 || startZ + nz > fnz) {
    throw new Error('Invalid subsection Z-range for embedding');
  }

  const result = new Uint8Array(fnx * fny * fnz);
  const sliceSize = nx * ny;
  for (let z = 0; z < nz; z++) {
    const srcOff = z * sliceSize;
    const dstOff = (startZ + z) * sliceSize;
    result.set(data.subarray(srcOff, srcOff + sliceSize), dstOff);
  }
  return result;
}

function zScoreNormalize(data) {
  const n = data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += data[i];
  }
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - mean;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / n) || 1;
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = (data[i] - mean) / std;
  }
  return result;
}

function computeForegroundBBox(data, dims, margin) {
  const [nx, ny, nz] = dims;
  let minX = nx, maxX = 0, minY = ny, maxY = 0, minZ = nz, maxZ = 0;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (data[x + y*nx + z*nx*ny] !== 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
  }

  if (maxX < minX) return null;

  return {
    origin: [
      Math.max(0, minX - margin),
      Math.max(0, minY - margin),
      Math.max(0, minZ - margin)
    ],
    end: [
      Math.min(nx, maxX + margin + 1),
      Math.min(ny, maxY + margin + 1),
      Math.min(nz, maxZ + margin + 1)
    ]
  };
}

function cropVolume(data, dims, bbox) {
  const [nx, ny] = dims;
  const [ox, oy, oz] = bbox.origin;
  const [ex, ey, ez] = bbox.end;
  const cnx = ex - ox, cny = ey - oy, cnz = ez - oz;

  const result = new Float32Array(cnx * cny * cnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = (z+oz)*nx*ny + (y+oy)*nx + ox;
      const dstOff = z*cnx*cny + y*cnx;
      result.set(data.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }

  return { data: result, dims: [cnx, cny, cnz], origin: [ox, oy, oz] };
}

// ==================== 3D Sliding Window ====================

function computeGaussianWeightMap3D(dim0, dim1, dim2, sigma) {
  if (!sigma) sigma = Math.min(dim0, dim1, dim2) / 8;
  const weights = new Float32Array(dim0 * dim1 * dim2);
  const c0 = (dim0 - 1) / 2;
  const c1 = (dim1 - 1) / 2;
  const c2 = (dim2 - 1) / 2;
  const s2 = 2 * sigma * sigma;
  for (let i0 = 0; i0 < dim0; i0++) {
    const d0 = i0 - c0;
    for (let i1 = 0; i1 < dim1; i1++) {
      const d1 = i1 - c1;
      for (let i2 = 0; i2 < dim2; i2++) {
        const d2 = i2 - c2;
        weights[i0 * dim1 * dim2 + i1 * dim2 + i2] = Math.exp(-(d0*d0 + d1*d1 + d2*d2) / s2);
      }
    }
  }
  return weights;
}

function computePatchPositions3D(volumeDims, patchDims, overlap) {
  const positions = [];
  const seen = new Set();

  const steps = patchDims.map(p => Math.max(1, Math.round(p * (1 - overlap))));

  const counts = volumeDims.map((vd, i) => {
    if (vd <= patchDims[i]) return 1;
    return Math.max(1, Math.ceil((vd - patchDims[i]) / steps[i]) + 1);
  });

  for (let iz = 0; iz < counts[2]; iz++) {
    let z = iz * steps[2];
    if (z + patchDims[2] > volumeDims[2]) z = Math.max(0, volumeDims[2] - patchDims[2]);

    for (let iy = 0; iy < counts[1]; iy++) {
      let y = iy * steps[1];
      if (y + patchDims[1] > volumeDims[1]) y = Math.max(0, volumeDims[1] - patchDims[1]);

      for (let ix = 0; ix < counts[0]; ix++) {
        let x = ix * steps[0];
        if (x + patchDims[0] > volumeDims[0]) x = Math.max(0, volumeDims[0] - patchDims[0]);

        const key = `${x},${y},${z}`;
        if (!seen.has(key)) {
          seen.add(key);
          positions.push([x, y, z]);
        }
      }
    }
  }

  return positions;
}

function extractPatch3D(volume, volumeDims, position, patchDims) {
  const [v0, v1, v2] = volumeDims;
  const [p0, p1, p2] = patchDims;
  const [o0, o1, o2] = position;
  const patch = new Float32Array(p0 * p1 * p2);

  for (let i0 = 0; i0 < p0; i0++) {
    const g0 = o0 + i0;
    if (g0 < 0 || g0 >= v0) continue;
    for (let i1 = 0; i1 < p1; i1++) {
      const g1 = o1 + i1;
      if (g1 < 0 || g1 >= v1) continue;
      for (let i2 = 0; i2 < p2; i2++) {
        const g2 = o2 + i2;
        if (g2 < 0 || g2 >= v2) continue;

        const srcIdx = g0 + g1 * v0 + g2 * v0 * v1;
        const dstIdx = i0 * p1 * p2 + i1 * p2 + i2;
        patch[dstIdx] = volume[srcIdx];
      }
    }
  }

  return patch;
}

function flipPatch3D(data, dims, axes) {
  const [p0, p1, p2] = dims;
  const flip0 = axes.includes(0);
  const flip1 = axes.includes(1);
  const flip2 = axes.includes(2);
  const result = new Float32Array(data.length);

  for (let i0 = 0; i0 < p0; i0++) {
    const s0 = flip0 ? p0 - 1 - i0 : i0;
    for (let i1 = 0; i1 < p1; i1++) {
      const s1 = flip1 ? p1 - 1 - i1 : i1;
      for (let i2 = 0; i2 < p2; i2++) {
        const s2 = flip2 ? p2 - 1 - i2 : i2;
        const dstIdx = i0 * p1 * p2 + i1 * p2 + i2;
        const srcIdx = s0 * p1 * p2 + s1 * p2 + s2;
        result[dstIdx] = data[srcIdx];
      }
    }
  }

  return result;
}

async function runPatchInference3D(session, inputName, outputName, patch, patchDims) {
  const [p0, p1, p2] = patchDims;
  const patchVoxels = p0 * p1 * p2;
  const inputTensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
  const results = await session.run({ [inputName]: inputTensor });
  const output = results[outputName].data;
  inputTensor.dispose();

  const probabilities = new Float32Array(patchVoxels);
  for (let i = 0; i < patchVoxels; i++) {
    probabilities[i] = 1.0 / (1.0 + Math.exp(-output[i]));
  }

  return { probabilities, logits: output };
}

function accumulatePatch3D(probAccum, weightAccum, volumeDims, position, output, weights, patchDims) {
  const [v0, v1, v2] = volumeDims;
  const [p0, p1, p2] = patchDims;
  const [o0, o1, o2] = position;

  for (let i0 = 0; i0 < p0; i0++) {
    const g0 = o0 + i0;
    if (g0 < 0 || g0 >= v0) continue;
    for (let i1 = 0; i1 < p1; i1++) {
      const g1 = o1 + i1;
      if (g1 < 0 || g1 >= v1) continue;
      for (let i2 = 0; i2 < p2; i2++) {
        const g2 = o2 + i2;
        if (g2 < 0 || g2 >= v2) continue;

        const patchIdx = i0 * p1 * p2 + i1 * p2 + i2;
        const globalIdx = g0 + g1 * v0 + g2 * v0 * v1;
        const w = weights[patchIdx];
        probAccum[globalIdx] += output[patchIdx] * w;
        weightAccum[globalIdx] += w;
      }
    }
  }
}

/** Direct-write patch into output (no weighting). For non-overlapping tiling. */
function writePatch3D(dest, volumeDims, position, output, patchDims) {
  const [v0, v1, v2] = volumeDims;
  const [p0, p1, p2] = patchDims;
  const [o0, o1, o2] = position;

  for (let i0 = 0; i0 < p0; i0++) {
    const g0 = o0 + i0;
    if (g0 < 0 || g0 >= v0) continue;
    for (let i1 = 0; i1 < p1; i1++) {
      const g1 = o1 + i1;
      if (g1 < 0 || g1 >= v1) continue;
      for (let i2 = 0; i2 < p2; i2++) {
        const g2 = o2 + i2;
        if (g2 < 0 || g2 >= v2) continue;

        dest[g0 + g1 * v0 + g2 * v0 * v1] = output[i0 * p1 * p2 + i1 * p2 + i2];
      }
    }
  }
}

// ==================== Postprocessing ====================

function connectedComponents3D(binaryMask, dims) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const labels = new Int32Array(n);
  let nextLabel = 1;
  const parent = [0];
  const rank = [0];

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  function union(a, b) {
    a = find(a); b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }

  const neighborOffsets = [];
  for (let dz = -1; dz <= 0; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && dy === 0 && dx >= 0) continue;
        neighborOffsets.push([dx, dy, dz]);
      }

  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const idx = z*ny*nx + y*nx + x;
        if (!binaryMask[idx]) continue;
        const neighborLabels = [];
        for (let i = 0; i < neighborOffsets.length; i++) {
          const nx2 = x+neighborOffsets[i][0], ny2 = y+neighborOffsets[i][1], nz2 = z+neighborOffsets[i][2];
          if (nx2<0||nx2>=nx||ny2<0||ny2>=ny||nz2<0||nz2>=nz) continue;
          const nIdx = nz2*ny*nx + ny2*nx + nx2;
          if (labels[nIdx] > 0) neighborLabels.push(labels[nIdx]);
        }
        if (neighborLabels.length === 0) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          rank.push(0);
          nextLabel++;
        } else {
          let minLabel = find(neighborLabels[0]);
          for (let i = 1; i < neighborLabels.length; i++) {
            const c = find(neighborLabels[i]);
            if (c < minLabel) minLabel = c;
          }
          labels[idx] = minLabel;
          for (let i = 0; i < neighborLabels.length; i++) union(minLabel, neighborLabels[i]);
        }
      }

  const canonicalMap = new Map();
  let finalLabel = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 0) continue;
    const root = find(labels[i]);
    if (!canonicalMap.has(root)) canonicalMap.set(root, ++finalLabel);
    labels[i] = canonicalMap.get(root);
  }
  return { labels, numComponents: finalLabel };
}

function removeSmallComponents(binaryMask, dims, minSize) {
  const n = dims[0] * dims[1] * dims[2];
  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);

  if (numComponents === 0) return binaryMask;

  const sizes = new Int32Array(numComponents + 1);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) sizes[labels[i]]++;
  }

  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0 && sizes[labels[i]] >= minSize) {
      result[i] = 1;
    }
  }

  return result;
}

/**
 * Keep only the largest connected component and fill interior holes.
 * Connected-component cleanup with hole filling.
 */
function keepLargestComponentAndFill(binaryMask, dims) {
  const n = dims[0] * dims[1] * dims[2];
  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);

  if (numComponents <= 1) return binaryMask;

  // Find largest component
  const sizes = new Int32Array(numComponents + 1);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) sizes[labels[i]]++;
  }
  let largestLabel = 1;
  for (let l = 2; l <= numComponents; l++) {
    if (sizes[l] > sizes[largestLabel]) largestLabel = l;
  }

  // Keep only largest
  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === largestLabel) result[i] = 1;
  }

  // Fill interior holes: find background CC touching the volume border,
  // then mark all other background voxels as brain (they are holes)
  const inverted = new Uint8Array(n);
  for (let i = 0; i < n; i++) inverted[i] = result[i] ? 0 : 1;
  const bgCC = connectedComponents3D(inverted, dims);

  // Find which background labels touch the border
  const [nx, ny, nz] = dims;
  const borderLabels = new Set();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (x === 0 || x === nx-1 || y === 0 || y === ny-1 || z === 0 || z === nz-1) {
          const idx = z*ny*nx + y*nx + x;
          if (bgCC.labels[idx] > 0) borderLabels.add(bgCC.labels[idx]);
        }
      }
    }
  }

  // Fill interior holes (background components not touching border)
  for (let i = 0; i < n; i++) {
    if (bgCC.labels[i] > 0 && !borderLabels.has(bgCC.labels[i])) {
      result[i] = 1;
    }
  }

  return result;
}

// ==================== Inverse Transform ====================

function uncrop(croppedData, croppedDims, fullDims, origin) {
  const [nx, ny, nz] = fullDims;
  const [cnx, cny, cnz] = croppedDims;
  const [ox, oy, oz] = origin;
  const result = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = z*cnx*cny + y*cnx;
      const dstOff = (z+oz)*nx*ny + (y+oy)*nx + ox;
      result.set(croppedData.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }
  return result;
}

function resampleLabelsNearest(data, dims, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);
  // Match scipy.ndimage.zoom(order=0): source = floor((output + 0.5) * srcSize / dstSize)
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

function inverseOrient(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Uint8Array(nx * ny * nz);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = ox + oy*dx + oz*dx*dy;
        const dstIdx = src[0] + src[1]*nx + src[2]*nx*ny;
        result[dstIdx] = data[srcIdx];
      }
    }
  }
  return result;
}

function inverseOrientFloat32(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Float32Array(nx * ny * nz);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = ox + oy*dx + oz*dx*dy;
        const dstIdx = src[0] + src[1]*nx + src[2]*nx*ny;
        result[dstIdx] = data[srcIdx];
      }
    }
  }
  return result;
}

// ==================== Model Loading ====================

async function fetchModel(url, modelName, progressBase, progressSpan) {
  const displayName = modelName || url.split('/').pop();
  const cacheKey = self._modelCacheKey || `${url}?v=${self._appVersion || ''}`;

  try {
    const cached = await localforage.getItem(cacheKey);
    if (cached && cached.byteLength > 100000) {
      postLog(`Model loaded from cache: ${displayName}`);
      postProgress(progressBase + progressSpan, `Cached: ${displayName}`);
      return cached;
    }
  } catch (e) { /* cache miss */ }

  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      postLog(`Downloading: ${displayName}${attempt > 1 ? ' (retry)' : ''}...`);
      response = await fetch(url, { cache: attempt > 1 ? 'reload' : 'default' });
      if (response.ok) break;
      lastError = new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
  }
  if (!response || !response.ok) {
    throw lastError || new Error(`Failed to fetch model: ${displayName}`);
  }

  const contentLength = parseInt(response.headers.get('content-length'), 10);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength) {
      const dlProgress = received / contentLength;
      const mb = (received / 1048576).toFixed(1);
      const totalMb = (contentLength / 1048576).toFixed(0);
      postProgress(progressBase + dlProgress * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
    }
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  if (data.byteLength <= 100000) {
    try {
      await localforage.removeItem(cacheKey);
    } catch (e) { /* ignore cleanup failure */ }
    throw new Error(`Downloaded model asset is unexpectedly small: ${displayName}`);
  }

  try {
    await localforage.setItem(cacheKey, data.buffer);
  } catch (e) {
    postLog('Warning: Could not cache model (storage full?)');
  }

  postLog(`Downloaded: ${displayName} (${(received / 1048576).toFixed(1)} MB)`);
  return data.buffer;
}

// ==================== WASM Preprocessing ====================

async function initWasmPreprocessing() {
  if (!wasmPreprocessingAvailable) return false;
  try {
    await wasm_bindgen('../preprocessing-wasm/preprocessing_bg.wasm');
    return true;
  } catch (e) {
    postLog('Warning: Could not initialize preprocessing WASM: ' + e.message);
    return false;
  }
}

// ==================== Utility ====================

function getOptimalWasmThreads() {
  return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
}

// ==================== Step Functions ====================

function loadStateFromInput(inputData, { emitUpdates = false } = {}) {
  if (emitUpdates) {
    postLog('Parsing input volume...');
    postProgress(0.02, 'Reading NIfTI...');
  }

  const { imageData, dims, voxelSize, headerBytes, affine } = parseNiftiInput(inputData);
  const [nx, ny, nz] = dims;
  if (emitUpdates) {
    postLog(`Volume: ${nx}x${ny}x${nz}, spacing: ${voxelSize.map(v => v.toFixed(3)).join('x')}mm`);
  }

  workerState.origDims = [...dims];
  workerState.affine = affine;
  workerState.headerBytes = headerBytes;

  // Orient to RAS
  if (emitUpdates) {
    postProgress(0.04, 'Orienting to RAS...');
    postLog('Orienting to RAS...');
  }
  const { perm, flip } = getOrientationTransform(affine);
  const isIdentity = perm[0] === 0 && perm[1] === 1 && perm[2] === 2 && !flip[0] && !flip[1] && !flip[2];

  workerState.perm = perm;
  workerState.flip = flip;
  workerState.isIdentity = isIdentity;

  if (isIdentity) {
    workerState.origHeaderBytes = headerBytes.slice(0);
    workerState.rasData = imageData;
    workerState.rasDims = [...dims];
    workerState.rasSpacing = [...voxelSize];
  } else {
    workerState.origHeaderBytes = headerBytes.slice(0);

    const oriented = orientToRAS(imageData, dims, perm, flip);
    workerState.rasData = oriented.data;
    workerState.rasDims = oriented.dims;
    workerState.rasSpacing = [voxelSize[perm[0]], voxelSize[perm[1]], voxelSize[perm[2]]];

    // Rewrite headerBytes sform to match the RAS-reoriented data
    const srcVoxel = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      srcVoxel[perm[i]] = flip[i] ? (workerState.rasDims[i] - 1) : 0;
    }
    const origin = [0, 0, 0];
    for (let r = 0; r < 3; r++) {
      origin[r] = affine[r][0] * srcVoxel[0]
                + affine[r][1] * srcVoxel[1]
                + affine[r][2] * srcVoxel[2]
                + affine[r][3];
    }

    const hdrView = new DataView(headerBytes);
    hdrView.setInt16(254, 1, true);
    hdrView.setFloat32(280, workerState.rasSpacing[0], true);
    hdrView.setFloat32(284, 0, true);
    hdrView.setFloat32(288, 0, true);
    hdrView.setFloat32(292, origin[0], true);
    hdrView.setFloat32(296, 0, true);
    hdrView.setFloat32(300, workerState.rasSpacing[1], true);
    hdrView.setFloat32(304, 0, true);
    hdrView.setFloat32(308, origin[1], true);
    hdrView.setFloat32(312, 0, true);
    hdrView.setFloat32(316, 0, true);
    hdrView.setFloat32(320, workerState.rasSpacing[2], true);
    hdrView.setFloat32(324, origin[2], true);
    hdrView.setInt16(252, 0, true);
  }
  if (emitUpdates) {
    postLog(`RAS dims: ${workerState.rasDims.join('x')}`);
  }

  // Clear downstream state
  workerState.brainMask = null;
  workerState.denoisedData = null;
  workerState.segLabelsRAS = null;
  workerState.segMinComponentSize = 10;

  // Post volume info for UI
  postVolumeInfo({
    rasDims: [...workerState.rasDims],
    rasSpacing: [...workerState.rasSpacing],
    totalSlices: workerState.rasDims[2]
  });
}

function stepLoad(inputData) {
  loadStateFromInput(inputData, { emitUpdates: true });

  postProgress(1.0, 'Volume loaded');
  postStepComplete('load');
}

async function restoreWorkerState(data) {
  resetState();
  loadStateFromInput(data.inputData, { emitUpdates: false });

  const hiddenArtifacts = data.hiddenArtifacts || {};
  workerState.segLabelsRAS = hiddenArtifacts.segmentationState?.segLabelsRAS
    ? new Uint8Array(hiddenArtifacts.segmentationState.segLabelsRAS)
    : null;
  workerState.segMinComponentSize = hiddenArtifacts.segmentationState?.segMinComponentSize ?? 10;

  postLog('Worker state restored');
  self.postMessage({ type: 'state-restored' });
}

async function stepInference(params) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }

  const {
    overlap = 0,
    threshold = 0.1,
    minComponentSize = 10,
    taskId = 'spinalcord',
    modelAssetId = 'sct-spinalcord',
    modelName = 'sct-spinalcord.onnx',
    patchSize = [64, 64, 64],
    modelBaseUrl,
    supportStatus = 'unvalidated',
    testTimeAugmentation = false,
    cacheKey,
    provenance = {}
  } = params;

  if (supportStatus !== 'supported') {
    throw new Error(`SCT task "${taskId}" is ${supportStatus}. Convert and validate model asset "${modelAssetId}" before running inference.`);
  }
  self._currentTaskId = taskId;

  const [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2] = patchSize;
  const patchDims = [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2];

  // Use denoised data if available, otherwise full RAS volume data
  let currentData = workerState.denoisedData
    ? new Float32Array(workerState.denoisedData)
    : new Float32Array(workerState.rasData);
  let currentDims = [...workerState.rasDims];
  let currentSpacing = [...workerState.rasSpacing];

  // Pad to multiples of patch size (matching Python: nearest-neighbor zoom)
  postProgress(0.05, 'Padding to patch grid...');
  const prePadDims = [...currentDims];
  const padded = padToPatchMultiple(currentData, currentDims, patchDims);
  if (padded.dims[0] !== currentDims[0] || padded.dims[1] !== currentDims[1] || padded.dims[2] !== currentDims[2]) {
    postLog(`Padded: ${currentDims.join('x')} -> ${padded.dims.join('x')} (nearest-neighbor)`);
    currentData = padded.data;
    currentDims = padded.dims;
  }
  const processingDims = [...currentDims];

  // Normalize (z-score over ALL voxels, matching Python standardiser)
  postProgress(0.10, 'Normalizing...');
  postLog('Z-score normalizing (all voxels)...');
  currentData = zScoreNormalize(currentData);
  postLog(`Volume: ${currentDims.join('x')}, range: [${Math.min(...currentData.slice(0,1000)).toFixed(3)}, ...]`);

  // Download and load model
  self._modelCacheKey = cacheKey || `${taskId}:${modelAssetId}:${self._appVersion || ''}`;
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(modelUrl, modelName, 0.12, 0.15);
  self._modelCacheKey = null;

  postProgress(0.27, 'Loading ONNX model...');
  const executionProviders = ['wasm'];
  postLog('Creating ONNX InferenceSession (wasm - 3D ops require WASM backend)...');
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders,
    graphOptimizationLevel: 'all'
  });
  postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

  // 3D Sliding Window Inference
  const gaussianWeights = computeGaussianWeightMap3D(PATCH_DIM0, PATCH_DIM1, PATCH_DIM2, 8);
  const positions = computePatchPositions3D(currentDims, patchDims, overlap);
  const totalPatches = positions.length;
  postLog(`Starting 3D inference: ${totalPatches} patches (${PATCH_DIM0}x${PATCH_DIM1}x${PATCH_DIM2}), overlap=${overlap}, TTA=${testTimeAugmentation ? 'on' : 'off'}, backend=wasm`);

  const totalVoxels = currentDims[0] * currentDims[1] * currentDims[2];
  const probAccum = new Float32Array(totalVoxels);
  const weightAccum = new Float32Array(totalVoxels);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const patchVoxels = PATCH_DIM0 * PATCH_DIM1 * PATCH_DIM2;
  const ttaAxes = [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];

  const inferenceStartTime = performance.now();

  for (let pi = 0; pi < totalPatches; pi++) {
    const pos = positions[pi];
    const patch = extractPatch3D(currentData, currentDims, pos, patchDims);

    const originalInference = await runPatchInference3D(session, inputName, outputName, patch, patchDims);
    let probabilities = originalInference.probabilities;

    if (testTimeAugmentation) {
      const probabilitySum = new Float32Array(probabilities);
      for (const axes of ttaAxes) {
        const flippedPatch = flipPatch3D(patch, patchDims, axes);
        const ttaInference = await runPatchInference3D(session, inputName, outputName, flippedPatch, patchDims);
        const unflipped = flipPatch3D(ttaInference.probabilities, patchDims, axes);
        for (let i = 0; i < patchVoxels; i++) {
          probabilitySum[i] += unflipped[i];
        }
      }
      probabilities = probabilitySum;
      const ttaCount = ttaAxes.length + 1;
      for (let i = 0; i < patchVoxels; i++) {
        probabilities[i] /= ttaCount;
      }
    }

    // Log first 5 patches and any foreground predictions for comparison with Python
    if (pi < 5) {
      let pMin = Infinity, pMax = -Infinity, pMean = 0, pAbove = 0;
      let oMin = Infinity, oMax = -Infinity;
      let inMin = Infinity, inMax = -Infinity, inMean = 0;
      for (let i = 0; i < patchVoxels; i++) {
        if (probabilities[i] < pMin) pMin = probabilities[i];
        if (probabilities[i] > pMax) pMax = probabilities[i];
        pMean += probabilities[i];
        if (probabilities[i] >= threshold) pAbove++;
        if (originalInference.logits[i] < oMin) oMin = originalInference.logits[i];
        if (originalInference.logits[i] > oMax) oMax = originalInference.logits[i];
        if (patch[i] < inMin) inMin = patch[i];
        if (patch[i] > inMax) inMax = patch[i];
        inMean += patch[i];
      }
      pMean /= patchVoxels;
      inMean /= patchVoxels;
      postLog(`Patch ${pi} pos=[${pos}]: in=[${inMin.toFixed(3)},${inMax.toFixed(3)}] mean=${inMean.toFixed(3)}, logit=[${oMin.toFixed(3)},${oMax.toFixed(3)}], prob=[${pMin.toFixed(4)},${pMax.toFixed(4)}] mean=${pMean.toFixed(4)}, n>thr=${pAbove}`);
    }

    accumulatePatch3D(probAccum, weightAccum, currentDims, pos, probabilities, gaussianWeights, patchDims);

    if (pi % 5 === 0 || pi === totalPatches - 1) {
      const elapsed = (performance.now() - inferenceStartTime) / 1000;
      const eta = (elapsed / (pi + 1)) * (totalPatches - pi - 1);
      postProgress(0.30 + 0.50 * ((pi + 1) / totalPatches), `Patch ${pi+1}/${totalPatches} (ETA: ${eta.toFixed(0)}s)`);
    }
  }

  const totalTime = ((performance.now() - inferenceStartTime) / 1000).toFixed(1);
  postLog(`Inference complete: ${totalPatches} patches in ${totalTime}s`);
  await session.release();

  // Log probability map stats for comparison with Python
  let probMin = Infinity, probMax = -Infinity, probSum = 0, probAboveThresh = 0;
  for (let i = 0; i < totalVoxels; i++) {
    const p = weightAccum[i] > 0 ? probAccum[i] / weightAccum[i] : 0;
    if (p < probMin) probMin = p;
    if (p > probMax) probMax = p;
    probSum += p;
    if (p >= threshold) probAboveThresh++;
  }
  postLog(`Prob map (padded ${currentDims.join('x')}): range=[${probMin.toFixed(4)},${probMax.toFixed(4)}], mean=${(probSum/totalVoxels).toFixed(6)}, voxels>=${threshold}=${probAboveThresh}`);

  // Threshold and binarize
  postProgress(0.82, 'Thresholding...');
  postLog(`Thresholding at p=${threshold}...`);
  const binaryMask = new Uint8Array(totalVoxels);
  for (let i = 0; i < totalVoxels; i++) {
    if (weightAccum[i] > 0) {
      const prob = probAccum[i] / weightAccum[i];
      if (prob >= threshold) {
        binaryMask[i] = 1;
      }
    }
  }

  // Count foreground voxels in padded space for diagnostic comparison
  let paddedForegroundCount = 0;
  for (let i = 0; i < totalVoxels; i++) {
    if (binaryMask[i]) paddedForegroundCount++;
  }
  postLog(`Foreground voxels (padded space): ${paddedForegroundCount}`);

  // Inverse transform: resize back to pre-pad dimensions FIRST
  postProgress(0.86, 'Inverse transform...');
  postLog('Applying inverse transforms...');
  let outputLabels = binaryMask;
  if (prePadDims[0] !== processingDims[0] || prePadDims[1] !== processingDims[1] || prePadDims[2] !== processingDims[2]) {
    outputLabels = resampleLabelsNearest(outputLabels, processingDims, prePadDims);
  }

  // Store unmasked labels so browser processing utilities can reuse them later.
  workerState.segLabelsRAS = new Uint8Array(outputLabels);
  workerState.segMinComponentSize = minComponentSize;
  emitSegmentationStateArtifact();

  if (workerState.brainMask) {
    let maskedOut = 0;
    for (let i = 0; i < outputLabels.length; i++) {
      if (outputLabels[i] && !workerState.brainMask[i]) {
        outputLabels[i] = 0;
        maskedOut++;
      }
    }
    if (maskedOut > 0) {
      postLog(`Brain mask removed ${maskedOut} segmentation voxels outside mask`);
    }
  }

  // Remove small connected components AFTER brain mask
  postProgress(0.90, 'Removing small components...');
  postLog(`Removing components smaller than ${minComponentSize} voxels...`);
  const rasDims = workerState.rasDims;
  const cleanedLabels = removeSmallComponents(outputLabels, rasDims, minComponentSize);
  let totalSegmented = 0;
  for (let i = 0; i < cleanedLabels.length; i++) {
    if (cleanedLabels[i]) totalSegmented++;
  }
  postLog(`Segmented voxels after CC: ${totalSegmented}`);
  outputLabels = cleanedLabels;

  // Inverse orient
  if (!workerState.isIdentity) {
    outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
  }

  // Create output NIfTI
  const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
  postStageData('segmentation', outputNifti, 'SCT segmentation');

  let finalVoxels = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) finalVoxels++;
  }
  postLog(`Output: ${finalVoxels} foreground voxels`);

  postProgress(1.0, 'Complete');
  postStepComplete('inference');
  postComplete();
}

// ==================== Message Handler ====================

self.onmessage = async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      try {
        self._appVersion = e.data.version || '';
        ort.env.wasm.numThreads = getOptimalWasmThreads();
        ort.env.wasm.wasmPaths = '../wasm/';

        postLog(`Using WASM backend (${ort.env.wasm.numThreads} threads)`);

        self._wasmReady = await initWasmPreprocessing();
        if (self._wasmReady) {
        postLog('Preprocessing WASM ready');
        }

        localforage.config({
          name: 'SCTModelCache',
          storeName: 'models'
        });

        self.postMessage({ type: 'initialized', wasmPreprocessingAvailable: self._wasmReady });
      } catch (error) {
        postError(`Initialization failed: ${error.message}`);
      }
      break;

    case 'load':
      try {
        stepLoad(data.inputData);
      } catch (error) {
        console.error('Load error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-inference':
      try {
        await stepInference(data || {});
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'reset-state':
      resetState();
      postLog('Worker state reset');
      break;

    case 'restore-state':
      try {
        await restoreWorkerState(data || {});
      } catch (error) {
        console.error('Restore error:', error);
        postError(error?.message || String(error));
      }
      break;

    // Legacy support for old 'run' message
    case 'run':
      try {
        // Decompose the old single-run into steps for backwards compat
        const { inputData, settings } = data;
        stepLoad(inputData);
        await stepInference({
          overlap: settings.overlap,
          taskId: settings.taskId,
          modelAssetId: settings.modelAssetId,
          supportStatus: settings.supportStatus,
          cacheKey: settings.cacheKey,
          provenance: settings.provenance,
          threshold: settings.probabilityThreshold,
          minComponentSize: settings.minComponentSize,
          modelName: settings.modelName,
          patchSize: settings.patchSize,
          testTimeAugmentation: settings.testTimeAugmentation,
          modelBaseUrl: settings.modelBaseUrl
        });
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;
  }
};
