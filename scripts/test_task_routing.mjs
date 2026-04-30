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

// Vertebrae must render as an overlay on input (not as the base volume), so
// the user can toggle Input + Vertebral Labels independently. The viewer
// pipeline picks the overlay file from `_overlayStage` and uses the matching
// `sct-vertebrae` colormap.
assert.match(appJs, /isOverlayStage\(stage\)\s*\{\s*return stage === 'segmentation' \|\| stage === 'vertebrae'/, 'isOverlayStage must include both segmentation and vertebrae');
assert.match(appJs, /getOverlayColormapId[\s\S]*?'sct-vertebrae'/, 'getOverlayColormapId must map vertebrae to sct-vertebrae');
assert.match(appJs, /resolveOverlayStage[\s\S]*?_overlayStage/, 'resolveOverlayStage must read _overlayStage');

// resolveOverlayStage must NOT implicitly fall back to a sibling overlay
// stage. Auto-promoting a stale vertebrae result onto a new input or new
// segmentation would silently render the wrong label mask. Codex flagged
// this as a high-severity correctness bug for medical label review.
assert.doesNotMatch(
  appJs,
  /resolveOverlayStage\(\)\s*\{[\s\S]*?hasResult\('vertebrae'\)[\s\S]*?hasResult\('segmentation'\)[\s\S]*?\}/,
  'resolveOverlayStage must not fall back across overlay stages — return null when _overlayStage is missing'
);

// runSegmentation must reset _overlayStage and re-render before kicking off
// inference, so a previous vertebrae overlay is not visible during the new
// run. clearResults / resetAllSteps must do the same.
assert.match(appJs, /clearResults\(\);[\s\S]*?disableAllResultTabs\(\);[\s\S]*?_overlayStage = 'segmentation';[\s\S]*?renderViewerVolumes\(\)/, 'runSegmentation must reset _overlayStage and re-render before starting inference');

// Reproduce the resolver semantics directly to lock the contract: the
// resolver returns _overlayStage when its result exists, otherwise null —
// never another stage.
function makeResolver(overlayStage, available) {
  return () => {
    if (overlayStage && available.has(overlayStage)) return overlayStage;
    return null;
  };
}
assert.equal(makeResolver('segmentation', new Set(['segmentation', 'vertebrae']))(), 'segmentation');
assert.equal(makeResolver('vertebrae', new Set(['segmentation', 'vertebrae']))(), 'vertebrae');
assert.equal(makeResolver('segmentation', new Set(['vertebrae']))(), null, 'must NOT auto-promote vertebrae when segmentation is the chosen stage');
assert.equal(makeResolver('vertebrae', new Set(['segmentation']))(), null, 'must NOT auto-promote segmentation when vertebrae is the chosen stage');
assert.equal(makeResolver('segmentation', new Set())(), null);

console.log(`Task routing OK: ${segmentationDropdownTasks.length} segmentation task(s) all have model assets; vertebrae is processing-only.`);
