#!/usr/bin/env node --no-warnings

// Asserts the SCT Segmentation task selector and the SCT Processing operation
// selector route work to the right pipeline. The browser silently fell back to
// the default model name when a user selected "Vertebral labeling" from the
// segmentation dropdown — runInference() spent ~22 minutes producing a sparse
// spinal cord segmentation, then claimed DONE without ever invoking the
// vertebrae module. The fix marks vertebrae as processingOnly and filters it
// from the segmentation dropdown; this test enforces the invariant.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  SCT_TASKS,
  isTaskRunnable,
  getPrimaryModelAsset
} = await import(pathToFileURL(path.join(ROOT, 'web/js/app/sct-tasks.js')));

// Tasks offered in the segmentation dropdown must each have a primary model
// asset. Without one, runInference() falls back to Config.MODEL.name.
const segmentationDropdownTasks = SCT_TASKS.filter(task => isTaskRunnable(task) && !task.processingOnly);
for (const task of segmentationDropdownTasks) {
  const asset = getPrimaryModelAsset(task);
  assert.ok(asset, `Task "${task.id}" appears in the segmentation dropdown but has no primary model asset. Either add modelAssets, mark it processingOnly, or set supportStatus to unsupported.`);
}

// The vertebrae task is post-processing and must be hidden from the segmentation
// dropdown but available from the SCT Processing operation dropdown.
const vertebrae = SCT_TASKS.find(task => task.id === 'vertebrae');
assert.ok(vertebrae, 'vertebrae task is defined');
assert.equal(vertebrae.processingOnly, true, 'vertebrae must be flagged processingOnly');
assert.ok(!segmentationDropdownTasks.includes(vertebrae), 'vertebrae must be filtered out of the segmentation dropdown');

const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const processingOptions = [...indexHtml.matchAll(/<select id="processingOperationSelect">([\s\S]*?)<\/select>/g)][0]?.[1] || '';
assert.match(processingOptions, /value="vertebrae"/, 'processingOperationSelect must offer vertebrae');

// runProcessingOperation must early-return on missing segmentation, and route
// 'vertebrae' to runVertebralLabeling rather than to runInference.
const appJs = fs.readFileSync(path.join(ROOT, 'web/js/spinalcordtoolbox-app.js'), 'utf8');
assert.match(appJs, /operation === 'vertebrae'[\s\S]*?hasResult\('segmentation'\)[\s\S]*?runVertebralLabeling/, 'runProcessingOperation must route vertebrae to runVertebralLabeling, gated on segmentation');

// runInference() must reject processingOnly / asset-less tasks rather than
// silently falling back to Config.MODEL.name.
assert.match(appJs, /processingOnly\s*\|\|\s*!selectedAsset/, 'runInference must guard against processingOnly tasks and missing model assets');

console.log(`Task routing OK: ${segmentationDropdownTasks.length} segmentation task(s) all have model assets; vertebrae is processing-only.`);
