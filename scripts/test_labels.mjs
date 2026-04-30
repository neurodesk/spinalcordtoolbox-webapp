#!/usr/bin/env node --no-warnings

// Asserts the NiiVue label LUT builder emits a step LUT — each label index
// gets a stop at the integer plus a second stop just below the next index,
// holding the color flat across (i, i+1). Without the second stop, NiiVue
// linearly interpolates between adjacent label colors and smears one
// vertebra into its neighbour at sub-voxel boundaries.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { generateNiivueColormap } = await import(pathToFileURL(path.join(ROOT, 'web/js/app/labels.js')));

const lut = generateNiivueColormap('vertebrae');

// 12 labels (background + 11 vertebrae). Step LUT adds a held stop between
// every consecutive pair of indices, so we expect 12 + 11 = 23 entries.
assert.equal(lut.I.length, 23, `expected 23 LUT stops, got ${lut.I.length}`);
assert.equal(lut.R.length, lut.I.length, 'R/I length mismatch');
assert.equal(lut.G.length, lut.I.length, 'G/I length mismatch');
assert.equal(lut.B.length, lut.I.length, 'B/I length mismatch');
assert.equal(lut.A.length, lut.I.length, 'A/I length mismatch');

assert.equal(lut.min, 0);
assert.equal(lut.max, 11);

// Each label index is followed by a held stop just below the next index,
// painted with the same color. That keeps NiiVue from interpolating across
// vertebrae.
for (let i = 0; i < lut.I.length - 1; i += 2) {
  const indexAtStart = lut.I[i];
  const indexBeforeNext = lut.I[i + 1];
  assert.ok(Number.isInteger(indexAtStart), `LUT[${i}] should be integer index, got ${indexAtStart}`);
  assert.ok(indexBeforeNext > indexAtStart, `held stop must come after index stop`);
  assert.ok(indexBeforeNext < indexAtStart + 1, `held stop must come before next integer`);
  assert.equal(lut.R[i], lut.R[i + 1], `R held flat across label ${indexAtStart}`);
  assert.equal(lut.G[i], lut.G[i + 1], `G held flat across label ${indexAtStart}`);
  assert.equal(lut.B[i], lut.B[i + 1], `B held flat across label ${indexAtStart}`);
}

// The spinalcord label set has only 2 labels (background + cord). Step LUT
// rule still applies: 2 + 1 held stop = 3 entries.
const cordLut = generateNiivueColormap('spinalcord');
assert.equal(cordLut.I.length, 3, 'spinalcord step LUT: 2 labels + 1 held stop');
assert.equal(cordLut.max, 1);

console.log(`Label LUT step encoding OK: vertebrae=${lut.I.length} stops, spinalcord=${cordLut.I.length} stops`);
