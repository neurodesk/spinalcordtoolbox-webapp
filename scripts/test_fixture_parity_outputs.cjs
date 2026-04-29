#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./batch-parity-fixtures.cjs');
const { loadNifti } = require('./batch-parity-lib.cjs');
const { ensureSctBatchFixtures } = require('./sct-docker-fixtures.cjs');
const manifest = require('../web/models/manifest.json');

const ROOT = path.resolve(__dirname, '..');

const CRITICAL_BROWSER_OUTPUTS = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.85,
    foregroundRatioTolerance: 0.5
  },
  {
    id: 'batch_t2s_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    taskId: 'graymatter',
    minDice: 0.7,
    foregroundRatioTolerance: 0.15
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t1',
    taskId: 'spinalcord',
    minDice: 0.9,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t2',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_mt_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.85,
    foregroundRatioTolerance: 0.2
  }
]);

function diceStats(expected, produced) {
  let expectedNz = 0;
  let producedNz = 0;
  let intersection = 0;
  for (let i = 0; i < expected.data.length; i++) {
    const e = expected.data[i] > 0;
    const p = produced.data[i] > 0;
    if (e) expectedNz++;
    if (p) producedNz++;
    if (e && p) intersection++;
  }
  return {
    expectedNz,
    producedNz,
    intersection,
    dice: expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1
  };
}

function assertMetadataComparable(fixture, expected, produced) {
  assert.equal(
    expected.header.dims.slice(0, 4).join('x'),
    produced.header.dims.slice(0, 4).join('x'),
    `${fixture.id}: browser output dimensions match test_data reference`
  );
  assert.equal(
    expected.header.pixDims.slice(1, 4).join('x'),
    produced.header.pixDims.slice(1, 4).join('x'),
    `${fixture.id}: browser output spacing matches test_data reference`
  );
  assert.equal(produced.header.datatypeCode, 2, `${fixture.id}: browser output is uint8 label data`);
}

const supportedTasks = new Set(
  manifest.tasks
    .filter(task => task.supportStatus === 'supported' && task.validationStatus === 'passed')
    .map(task => task.id)
);

function missingBrowserOutputs() {
  return CRITICAL_BROWSER_OUTPUTS
    .map(check => fixtures.FIXTURE_CASES.find(item => item.id === check.id))
    .filter(Boolean)
    .map(fixture => path.join(ROOT, path.dirname(fixture.inputPath), 'browser_output.nii.gz'))
    .filter(filePath => !fs.existsSync(filePath));
}

function ensureBrowserOutputs() {
  const force = process.env.BROWSER_FIXTURE_REGENERATE === '1';
  if (!force && missingBrowserOutputs().length === 0) return;

  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run_browser_fixture_outputs.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'browser fixture output generation exits successfully');
}

ensureSctBatchFixtures(ROOT);
ensureBrowserOutputs();

for (const taskId of supportedTasks) {
  assert.ok(
    CRITICAL_BROWSER_OUTPUTS.some(item => item.taskId === taskId),
    `supported task ${taskId} has at least one browser-output parity fixture`
  );
}

const results = [];
for (const check of CRITICAL_BROWSER_OUTPUTS) {
  const fixture = fixtures.FIXTURE_CASES.find(item => item.id === check.id);
  assert.ok(fixture, `${check.id} fixture exists`);

  const expectedPath = path.join(ROOT, fixture.expectedOutputPath);
  const producedPath = path.join(ROOT, path.dirname(fixture.inputPath), 'browser_output.nii.gz');
  assert.notEqual(path.resolve(expectedPath), path.resolve(producedPath), `${check.id}: produced output is not the expected fixture`);
  assert.ok(fs.existsSync(producedPath), `${check.id}: browser output exists at ${path.relative(ROOT, producedPath)}`);

  const expected = loadNifti(expectedPath);
  const produced = loadNifti(producedPath);
  assertMetadataComparable(fixture, expected, produced);

  const stats = diceStats(expected, produced);
  const lower = stats.expectedNz * (1 - check.foregroundRatioTolerance);
  const upper = stats.expectedNz * (1 + check.foregroundRatioTolerance);
  assert.ok(stats.producedNz >= lower && stats.producedNz <= upper, `${check.id}: foreground ${stats.producedNz} is within tolerance of ${stats.expectedNz}`);
  assert.ok(stats.dice >= check.minDice, `${check.id}: Dice ${stats.dice.toFixed(4)} >= ${check.minDice.toFixed(4)}`);
  results.push(`${check.id}: dice=${stats.dice.toFixed(4)} expectedNz=${stats.expectedNz} producedNz=${stats.producedNz}`);
}

console.log(`Browser fixture parity passed:\n${results.join('\n')}`);
