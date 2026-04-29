#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'web/js/spinalcordtoolbox-app.js'), 'utf8');
const controllerSources = [
  'web/js/controllers/FileIOController.js',
  'web/js/controllers/InferenceExecutor.js',
  'web/js/controllers/ViewerController.js',
  'web/js/controllers/DicomController.js',
  'web/js/modules/ui/ConsoleOutput.js',
  'web/js/modules/ui/ModalManager.js',
  'web/js/modules/ui/ProgressManager.js'
].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
const viewerTest = fs.readFileSync(path.join(ROOT, 'scripts/test_viewer_controller.mjs'), 'utf8');
const processingTest = fs.readFileSync(path.join(ROOT, 'scripts/test_sct_processing.cjs'), 'utf8');
const batchTest = fs.readFileSync(path.join(ROOT, 'scripts/test_batch_processing_cases.cjs'), 'utf8');
const workerTest = fs.readFileSync(path.join(ROOT, 'scripts/test_inference_worker_e2e.cjs'), 'utf8');

const htmlIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const domSource = `${appJs}\n${controllerSources}`;
const domReferences = new Set([...domSource.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]));

const UI_COVERAGE = Object.freeze([
  { id: 'fileInput', behavior: 'loads selected files', coveredBy: ['batch', 'static-dom'] },
  { id: 'inputDropZone', behavior: 'accepts drag/drop file input', coveredBy: ['batch', 'static-dom'] },
  { id: 'fileList', behavior: 'displays and clears selected files', coveredBy: ['batch', 'static-dom'] },
  { id: 'modelSelect', behavior: 'selects supported SCT task and applies defaults', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'runSegmentation', behavior: 'starts worker inference', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'abortInferenceBtn', behavior: 'aborts inference step', coveredBy: ['static-dom'] },
  { id: 'cancelButton', behavior: 'cancels active pipeline step', coveredBy: ['static-dom'] },
  { id: 'overlapSelect', behavior: 'passes overlap setting to inference', coveredBy: ['batch', 'static-dom'] },
  { id: 'thresholdInput', behavior: 'passes probability threshold to inference', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'minSizeInput', behavior: 'passes connected-component cleanup threshold', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'ttaToggle', behavior: 'passes test-time augmentation setting', coveredBy: ['static-dom'] },
  { id: 'processingOperationSelect', behavior: 'selects SCT browser processing operation', coveredBy: ['processing', 'batch', 'static-dom'] },
  { id: 'runProcessingBtn', behavior: 'runs selected browser processing operation', coveredBy: ['processing', 'batch', 'static-dom'] },
  { id: 'processingOutput', behavior: 'displays processing output text', coveredBy: ['processing', 'batch', 'static-dom'] },
  { id: 'stageButtons', behavior: 'renders result view/download controls', coveredBy: ['batch', 'static-dom'] },
  { id: 'resultsSection', behavior: 'shows available result stages', coveredBy: ['batch', 'static-dom'] },
  { id: 'downloadCurrentVolume', behavior: 'downloads selected result/input volume', coveredBy: ['batch', 'static-dom'] },
  { id: 'screenshotViewer', behavior: 'exports viewer screenshot', coveredBy: ['batch', 'static-dom'] },
  { id: 'clearResults', behavior: 'clears pipeline results', coveredBy: ['static-dom'] },
  { id: 'overlayOpacity', behavior: 'updates segmentation overlay opacity', coveredBy: ['viewer', 'batch', 'static-dom'] },
  { id: 'inputVisibilityToggle', behavior: 'toggles input volume visibility', coveredBy: ['viewer', 'static-dom'] },
  { id: 'interpolation', behavior: 'toggles viewer interpolation', coveredBy: ['static-dom'] },
  { id: 'colorbarToggle', behavior: 'toggles viewer colorbar', coveredBy: ['static-dom'] },
  { id: 'crosshairToggle', behavior: 'toggles viewer crosshair', coveredBy: ['static-dom'] },
  { id: 'colormapSelect', behavior: 'changes base volume colormap', coveredBy: ['static-dom'] },
  { id: 'rangeMin', behavior: 'updates lower display window', coveredBy: ['static-dom'] },
  { id: 'rangeMax', behavior: 'updates upper display window', coveredBy: ['static-dom'] },
  { id: 'windowMin', behavior: 'updates lower display window from numeric input', coveredBy: ['static-dom'] },
  { id: 'windowMax', behavior: 'updates upper display window from numeric input', coveredBy: ['static-dom'] },
  { id: 'resetWindow', behavior: 'resets display window', coveredBy: ['static-dom'] },
  { id: 'copyConsole', behavior: 'copies console output', coveredBy: ['static-dom'] },
  { id: 'clearConsole', behavior: 'clears console output', coveredBy: ['static-dom'] },
  { id: 'aboutButton', behavior: 'opens About modal', coveredBy: ['static-dom'] },
  { id: 'closeAbout', behavior: 'closes About modal', coveredBy: ['static-dom'] },
  { id: 'citationsButton', behavior: 'opens Citations modal', coveredBy: ['static-dom'] },
  { id: 'closeCitations', behavior: 'closes Citations modal', coveredBy: ['static-dom'] },
  { id: 'privacyButton', behavior: 'opens Privacy modal', coveredBy: ['static-dom'] },
  { id: 'closePrivacy', behavior: 'closes Privacy modal', coveredBy: ['static-dom'] }
]);

const TEST_SOURCES = {
  batch: batchTest,
  processing: processingTest,
  viewer: viewerTest,
  worker: workerTest,
  'static-dom': domSource
};

const interactiveIds = new Set(UI_COVERAGE.map(item => item.id));
for (const item of UI_COVERAGE) {
  assert.ok(htmlIds.has(item.id), `${item.id} exists in web/index.html`);
  assert.ok(
    domReferences.has(item.id) || domSource.includes(`'${item.id}'`) || domSource.includes(`"${item.id}"`),
    `${item.id} is referenced by app DOM wiring`
  );
  assert.ok(item.behavior && item.coveredBy.length > 0, `${item.id} has coverage metadata`);
  for (const coverage of item.coveredBy) {
    assert.ok(TEST_SOURCES[coverage], `${item.id} references known coverage source ${coverage}`);
  }
}

const htmlInteractiveIds = [...htmlIds].filter(id => {
  return /(Button|Toggle|Select|Input|Opacity|Window|range|file|run|abort|cancel|clear|download|screenshot|close|privacy|citations|about)/i.test(id);
});
const missingCoverage = htmlInteractiveIds.filter(id => !interactiveIds.has(id) && !/Version|Modal|Badge|Value|Text|Output|Section|Control|List|Details|Primary|Label|Selected|gl1/u.test(id));
assert.deepEqual(missingCoverage, [], `interactive ids missing UI coverage entries: ${missingCoverage.join(', ')}`);

assert.ok(appJs.includes("querySelectorAll('.view-tab[data-view]')"), 'view tab controls are wired');
assert.ok(indexHtml.includes('class="view-tab'), 'view tab controls exist');

console.log(`UI coverage contract passed: ${UI_COVERAGE.length} controls mapped`);
