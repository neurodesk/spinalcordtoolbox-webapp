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

const lesionSci = SCT_TASKS.find(task => task.id === 'lesion_sci_t2');
assert.ok(lesionSci, 'lesion_sci_t2 task is defined');
assert.equal(lesionSci.supportStatus, 'supported', 'lesion_sci_t2 must be runnable from SCT Segmentation');
assert.ok(segmentationDropdownTasks.includes(lesionSci), 'lesion_sci_t2 must appear in the segmentation dropdown');
assert.deepEqual(lesionSci.outputStages?.map(stage => stage.id), ['segmentation', 'lesion', 'lesion_metrics'], 'lesion_sci_t2 must declare spinal-cord, lesion, and metrics stages');
assert.equal(getPrimaryModelAsset(lesionSci)?.output?.activation, 'sigmoid-regions', 'lesion_sci_t2 must use SCIsegV2 region-channel output metadata');

const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const processingOptions = [...indexHtml.matchAll(/<select id="processingOperationSelect">([\s\S]*?)<\/select>/g)][0]?.[1] || '';
assert.match(processingOptions, /value="vertebrae"/, 'processingOperationSelect must offer vertebrae');
const exposedProcessingOptionValues = [...processingOptions.matchAll(/<option\s+value="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(exposedProcessingOptionValues, ['vertebrae'], 'processingOperationSelect must only expose real pipeline operations');
assert.doesNotMatch(
  processingOptions,
  /centerline|morphometry|mt|dmri|registration|metadata/i,
  'processingOperationSelect must not expose pure helper/demo operations'
);

// runProcessingOperation must early-return on missing segmentation, and route
// 'vertebrae' to runVertebralLabeling rather than to runInference.
const appJs = fs.readFileSync(path.join(ROOT, 'web/js/spinalcordtoolbox-app.js'), 'utf8');
assert.match(appJs, /operation === 'vertebrae'[\s\S]*?hasResult\('segmentation'\)[\s\S]*?runVertebralLabeling/, 'runProcessingOperation must route vertebrae to runVertebralLabeling, gated on segmentation');

// runInference() must reject processingOnly / asset-less tasks rather than
// silently falling back to Config.MODEL.name.
assert.match(appJs, /processingOnly\s*\|\|\s*!selectedAsset/, 'runInference must guard against processingOnly tasks and missing model assets');

// Label masks must be independently toggleable result stages. When input is
// visible they render as overlays; when input is hidden, renderViewerVolumes()
// promotes the first visible label mask to the NiiVue base volume because
// volume 0 is not a reliable hide target.
assert.match(appJs, /isOverlayStage\(stage\)\s*\{\s*return stage === 'segmentation' \|\| stage === 'lesion' \|\| stage === 'vertebrae'/, 'isOverlayStage must include segmentation, lesion, and vertebrae');
assert.match(appJs, /getOverlayColormapId[\s\S]*?'sct-vertebrae'/, 'getOverlayColormapId must map vertebrae to sct-vertebrae');
assert.match(appJs, /getOverlayColormapId[\s\S]*?'sct-lesion'/, 'getOverlayColormapId must map lesion to sct-lesion');
assert.match(appJs, /_stageVisibility\s*=\s*\{[\s\S]*?segmentation:\s*true[\s\S]*?lesion:\s*true[\s\S]*?vertebrae:\s*true/, 'result visibility must be tracked per stage');
assert.match(appJs, /getVisibleOverlayStages\(\)[\s\S]*?\['segmentation', 'lesion', 'vertebrae'\][\s\S]*?isStageVisible\(stage\)[\s\S]*?hasResult\(stage\)/, 'visible overlay stages must be resolved from per-stage visibility and existing results');
assert.match(appJs, /stackEntries\s*=\s*\[\{[\s\S]*?stage:\s*baseOverlayStage[\s\S]*?labelMask:\s*true[\s\S]*?loadViewerStackIfChanged\(stackEntries\)/, 'hidden-input rendering must promote the first visible label mask to the base volume with stage tracking');
assert.match(appJs, /for \(const overlayStage of visibleOverlayStages\)[\s\S]*?stackEntries\.push\(\{[\s\S]*?stage:\s*overlayStage[\s\S]*?labelMask:\s*true[\s\S]*?loadViewerStackIfChanged\(stackEntries\)/, 'visible label masks must be loaded as one independently tracked volume stack');
assert.match(appJs, /_renderViewerPromise\s*=\s*Promise\.resolve\(\)/, 'viewer renders must be serialized to prevent late base loads from wiping overlays');
assert.match(appJs, /renderViewerVolumes\(\)\s*\{[\s\S]*?_renderViewerPromise\s*=\s*this\._renderViewerPromise\.then/, 'renderViewerVolumes must enqueue render work in order');
assert.match(appJs, /loadViewerStackIfChanged\(stackEntries\)\s*\{[\s\S]*?isCurrentVolumeStack\?\.\(stackEntries\)[\s\S]*?return false[\s\S]*?loadVolumeStack\(stackEntries\)/, 'renderViewerVolumes must skip loadVolumeStack when the requested stack is already current');
assert.match(appJs, /getResultListStages\(\)\s*\{[\s\S]*?getStageOrder\(\)\.filter\(stage => !this\.isMetricsResultStage\(stage\)\)/, 'metrics stages must be excluded from the viewable/downloadable image-layer result list');
assert.match(appJs, /renderMetricsResult\(stage\)[\s\S]*?metrics-download-btn[\s\S]*?downloadMetricsResult\(stage\)/, 'metrics statistics panel must provide its own CSV download button');
assert.match(appJs, /downloadMetricsResult\(stage\)[\s\S]*?result\?\.kind !== 'metrics'[\s\S]*?Downloaded statistics/, 'metrics CSV download must be handled as statistics, not as a layer download');

// Visibility must not resurrect missing sibling results. Auto-rendering a
// stale vertebrae result onto a new input or new segmentation would silently
// render the wrong label mask.
assert.doesNotMatch(
  appJs,
  /getVisibleOverlayStages\(\)\s*\{[\s\S]*?return\s+\['segmentation', 'lesion', 'vertebrae'\]\.filter\(stage => \(\s*this\.isStageVisible\(stage\)\s*\)\)/,
  'getVisibleOverlayStages must also require an existing result for each visible stage'
);

// runSegmentation must reset visibility and re-render before kicking off
// inference, so a previous vertebrae overlay is not visible during the new run.
assert.match(appJs, /clearResults\(\);[\s\S]*?disableAllResultTabs\(\);[\s\S]*?resetStageVisibility\(\);[\s\S]*?renderViewerVolumes\(\)/, 'runSegmentation must reset stage visibility and re-render before starting inference');

// Reproduce the visible-stage semantics directly: each result controls only
// its own visibility, and missing results are excluded even when their default
// visibility flag is on.
function getVisibleOverlayStages(visibility, available) {
  return ['segmentation', 'lesion', 'vertebrae'].filter(stage => visibility[stage] && available.has(stage));
}
assert.deepEqual(getVisibleOverlayStages({ segmentation: true, lesion: true, vertebrae: true }, new Set(['segmentation', 'lesion', 'vertebrae'])), ['segmentation', 'lesion', 'vertebrae']);
assert.deepEqual(getVisibleOverlayStages({ segmentation: true, lesion: false, vertebrae: true }, new Set(['segmentation', 'lesion', 'vertebrae'])), ['segmentation', 'vertebrae']);
assert.deepEqual(getVisibleOverlayStages({ segmentation: false, lesion: true, vertebrae: true }, new Set(['segmentation', 'lesion', 'vertebrae'])), ['lesion', 'vertebrae']);
assert.deepEqual(getVisibleOverlayStages({ segmentation: true, lesion: true, vertebrae: true }, new Set(['segmentation'])), ['segmentation'], 'must not render missing sibling results');
assert.deepEqual(getVisibleOverlayStages({ segmentation: false, lesion: false, vertebrae: false }, new Set(['segmentation', 'lesion', 'vertebrae'])), []);

console.log(`Task routing OK: ${segmentationDropdownTasks.length} segmentation task(s) all have model assets; vertebrae is processing-only.`);
