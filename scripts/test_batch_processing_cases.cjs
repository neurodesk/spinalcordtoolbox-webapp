#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../web/models/manifest.json');

const SUPPORTED_TASK_STATUSES = new Set(['supported', 'unvalidated', 'unsupported']);
const BATCH_PROCESSING_SOURCE =
  'https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/batch_processing.sh';
const ROOT = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'web/js/spinalcordtoolbox-app.js'), 'utf8');
const executorJs = fs.readFileSync(path.join(ROOT, 'web/js/controllers/InferenceExecutor.js'), 'utf8');
const workerJs = fs.readFileSync(path.join(ROOT, 'web/js/inference-worker.js'), 'utf8');

const WEBAPP_PIPELINE_FEATURES = Object.freeze({
  input: {
    controls: ['fileInput', 'inputDropZone', 'fileList'],
    workerMessages: ['load'],
    labels: ['Drop NIfTI or DICOM files']
  },
  segmentation: {
    controls: ['stepInferenceSection', 'modelSelect', 'runSegmentation', 'overlapSelect', 'thresholdInput', 'minSizeInput'],
    workerMessages: ['run-inference'],
    labels: ['SCT Segmentation', 'SCT Task', 'Probability Threshold', 'Min Component Size']
  },
  processing: {
    controls: ['stepProcessingSection', 'processingOperationSelect', 'runProcessingBtn', 'processingOutput'],
    workerMessages: [],
    labels: ['SCT Processing', 'Centerline + mask + crop', 'Morphometry CSV', 'MTR / MTsat maps', 'dMRI split + DTI metrics']
  },
  results: {
    controls: ['resultsSection', 'stageButtons', 'downloadCurrentVolume', 'screenshotViewer', 'overlayOpacity'],
    workerMessages: ['stageData'],
    labels: ['Results']
  }
});

const BROWSER_LIBRARY_FEATURES = Object.freeze({
  centerline: ['centerlineFromSegmentation'],
  morphometry: ['sliceMorphometry', 'morphometryToCsv'],
  imageMath: ['subtractVolumes', 'meanTimeSeries'],
  maskCrop: ['createCylinderMask', 'boundingBoxFromMask', 'cropVolume'],
  mtMetrics: ['computeMTR', 'computeMTsat'],
  dmriSplit: ['identifyB0Dwi', 'splitB0Dwi'],
  dtiMetrics: ['computeDtiMetrics'],
  labelUtils: ['createLabelsFromVertBody'],
  smoothing: ['smoothAlongAxis'],
  metricExtraction: ['extractMetricByLabels', 'metricRowsToCsv'],
  qcReport: ['createQcReportHtml'],
  sampleDataDownload: ['getSctExampleDataManifest'],
  modelInstall: ['getBrowserModelInstallPlan'],
  vertebralLabeling: ['labelVertebraeFromSegmentation'],
  templateRegistration: ['registerByCenterOfMass', 'applyTranslation', 'warpTemplate'],
  pmjDetection: ['detectPmj'],
  flattening: ['flattenSagittal'],
  dmriMoco: ['motionCorrectTimeSeries'],
  fmriPreprocessing: ['meanTimeSeries', 'motionCorrectTimeSeries']
});

const NATIVE_ONLY_FEATURES = Object.freeze({});

const RAW_CASES = `
59|setup|-|-|sct_download_data -d sct_example_data
66|setup|-|-|sct_deepseg spinalcord -install
72|t2|spinalcord|T2w|sct_deepseg spinalcord -i t2.nii.gz -qc "$SCT_BP_QC_FOLDER"
76|t2|-|-|sct_get_centerline -i t2_seg.nii.gz -method fitseg -qc "$SCT_BP_QC_FOLDER"
78|t2|-|-|sct_get_centerline -i t2_seg.nii.gz -method fitseg -centerline-soft 1 -o t2_seg_centerline_soft.nii.gz -qc "$SCT_BP_QC_FOLDER"
81|t2|-|-|sct_label_vertebrae -i t2.nii.gz -s t2_seg.nii.gz -c t2 -qc "$SCT_BP_QC_FOLDER"
83|t2|-|-|sct_label_utils -i t2_seg_labeled.nii.gz -vert-body 2,5 -o labels_vert.nii.gz
87|t2|-|-|sct_register_to_template -i t2.nii.gz -s t2_seg.nii.gz -l labels_vert.nii.gz -c t2 -qc "$SCT_BP_QC_FOLDER"
94|t2|-|-|sct_warp_template -d t2.nii.gz -w warp_template2anat.nii.gz -a 0
96|t2|-|-|sct_process_segmentation -i t2_seg.nii.gz
98|t2|-|-|sct_process_segmentation -i t2_seg.nii.gz -vert 2:3 -o csa_c2c3.csv
101|t2|-|-|sct_detect_pmj -i t2.nii.gz -c t2 -qc "$SCT_BP_QC_FOLDER"
103|t2|-|-|sct_process_segmentation -i t2_seg.nii.gz -pmj t2_pmj.nii.gz -pmj-distance 60 -pmj-extent 30 -qc "$SCT_BP_QC_FOLDER" -qc-image t2.nii.gz -o csa_pmj.csv
105|t2|-|-|sct_process_segmentation -i t2_seg.nii.gz -vertfile t2_seg_labeled.nii.gz -perslice 1 -normalize-PAM50 1 -o csa_pam50.csv
114|t2s|spinalcord|T2star|sct_deepseg spinalcord -i t2s.nii.gz -qc "$SCT_BP_QC_FOLDER"
116|t2s|graymatter|T2star|sct_deepseg_gm -i t2s.nii.gz -qc "$SCT_BP_QC_FOLDER"
118|t2s|-|-|sct_register_multimodal -i "$SCT_DIR/data/PAM50/template/PAM50_t2s.nii.gz" -iseg "$SCT_DIR/data/PAM50/template/PAM50_cord.nii.gz" -d t2s.nii.gz -dseg t2s_seg.nii.gz -param step=1,type=seg,algo=centermass:step=2,type=seg,algo=bsplinesyn,slicewise=1,iter=3:step=3,type=im,algo=syn,slicewise=1,iter=1,metric=CC -initwarp ../t2/warp_template2anat.nii.gz -initwarpinv ../t2/warp_anat2template.nii.gz -owarp warp_template2t2s.nii.gz -owarpinv warp_t2s2template.nii.gz
120|t2s|-|-|sct_warp_template -d t2s.nii.gz -w warp_template2t2s.nii.gz
122|t2s|-|-|sct_maths -i t2s_seg.nii.gz -sub t2s_gmseg.nii.gz -o t2s_wmseg.nii.gz
124|t2s|-|-|sct_process_segmentation -i t2s_wmseg.nii.gz -vert 2:5 -perlevel 1 -o csa_wm.csv -centerline t2s_seg.nii.gz
125|t2s|-|-|sct_process_segmentation -i t2s_gmseg.nii.gz -vert 2:5 -perlevel 1 -o csa_gm.csv -centerline t2s_seg.nii.gz
141|t1|spinalcord|T1w|sct_deepseg spinalcord -i t1.nii.gz
142|t1|-|-|sct_create_mask -i t1.nii.gz -p centerline,t1_seg.nii.gz -size 35mm -f cylinder -o mask_t1.nii.gz
143|t1|-|-|sct_crop_image -i t1.nii.gz -m mask_t1.nii.gz
146|t1|spinalcord|T2w|sct_deepseg spinalcord -i t2.nii.gz
147|t1|-|-|sct_create_mask -i t2.nii.gz -p centerline,t2_seg.nii.gz -size 35mm -f cylinder -o mask_t2.nii.gz
148|t1|-|-|sct_crop_image -i t2.nii.gz -m mask_t2.nii.gz
150|t1|-|-|sct_register_multimodal -i t1_crop.nii.gz -d t2_crop.nii.gz -param step=1,type=im,algo=dl
154|t1|-|-|sct_smooth_spinalcord -i t1.nii.gz -s t1_seg.nii.gz
156|t1|-|-|sct_flatten_sagittal -i t1.nii.gz -s t1_seg.nii.gz
165|mt|-|-|sct_get_centerline -i mt1.nii.gz -c t2
168|mt|-|-|sct_create_mask -i mt1.nii.gz -p centerline,mt1_centerline.nii.gz -size 45mm
170|mt|-|-|sct_crop_image -i mt1.nii.gz -m mask_mt1.nii.gz -o mt1_crop.nii.gz
172|mt|spinalcord|MT|sct_deepseg spinalcord -i mt1_crop.nii.gz -qc "$SCT_BP_QC_FOLDER"
176|mt|-|-|sct_register_multimodal -i mt0.nii.gz -d mt1_crop.nii.gz -dseg mt1_crop_seg.nii.gz -param step=1,type=im,algo=slicereg,metric=CC -x spline -qc "$SCT_BP_QC_FOLDER"
180|mt|-|-|sct_register_multimodal -i "$SCT_DIR/data/PAM50/template/PAM50_t2.nii.gz" -iseg "$SCT_DIR/data/PAM50/template/PAM50_cord.nii.gz" -d mt1_crop.nii.gz -dseg mt1_crop_seg.nii.gz -param step=1,type=seg,algo=slicereg,smooth=3:step=2,type=seg,algo=bsplinesyn,slicewise=1,iter=3 -initwarp ../t2/warp_template2anat.nii.gz -initwarpinv ../t2/warp_anat2template.nii.gz -owarp warp_template2mt.nii.gz -owarpinv warp_mt2template.nii.gz
182|mt|-|-|sct_warp_template -d mt1_crop.nii.gz -w warp_template2mt.nii.gz -qc "$SCT_BP_QC_FOLDER"
184|mt|-|-|sct_compute_mtr -mt0 mt0_reg.nii.gz -mt1 mt1_crop.nii.gz
187|mt|-|-|sct_register_multimodal -i t1w.nii.gz -d mt1_crop.nii.gz -dseg mt1_crop_seg.nii.gz -param step=1,type=im,algo=slicereg,metric=CC -x spline -qc "$SCT_BP_QC_FOLDER"
190|mt|-|-|sct_compute_mtsat -mt mt1_crop.nii.gz -pd mt0_reg.nii.gz -t1 t1w_reg.nii.gz -trmt 0.030 -trpd 0.030 -trt1 0.015 -famt 9 -fapd 9 -fat1 15
193|mt|-|-|sct_extract_metric -i mtr.nii.gz -method map -o mtr_in_wm.csv -l 51 -vert 2:5
194|mt|-|-|sct_extract_metric -i mtsat.nii.gz -method map -o mtsat_in_wm.csv -l 51 -vert 2:5
195|mt|-|-|sct_extract_metric -i t1map.nii.gz -method map -o t1_in_wm.csv -l 51 -vert 2:5
197|mt|-|-|sct_apply_transfo -i mtr.nii.gz -d "$SCT_DIR/data/PAM50/template/PAM50_t2.nii.gz" -w warp_mt2template.nii.gz
206|dmri|-|-|sct_dmri_separate_b0_and_dwi -i dmri.nii.gz -bvec bvecs.txt
207|dmri|-|-|sct_register_multimodal -i ../t2/t2_seg.nii.gz -d dmri_dwi_mean.nii.gz -identity 1 -x nn
209|dmri|-|-|sct_create_mask -i dmri_dwi_mean.nii.gz -p centerline,t2_seg_reg.nii.gz -size 35mm
212|dmri|-|-|sct_dmri_moco -i dmri.nii.gz -bvec bvecs.txt -m mask_dmri_dwi_mean.nii.gz
214|dmri|spinalcord|DWI|sct_deepseg spinalcord -i dmri_moco_dwi_mean.nii.gz -qc "$SCT_BP_QC_FOLDER"
216|dmri|-|-|sct_qc -i dmri.nii.gz -d dmri_moco.nii.gz -s dmri_moco_dwi_mean_seg.nii.gz -p sct_dmri_moco -qc "$SCT_BP_QC_FOLDER"
219|dmri|-|-|sct_register_multimodal -i "$SCT_DIR/data/PAM50/template/PAM50_t1.nii.gz" -iseg "$SCT_DIR/data/PAM50/template/PAM50_cord.nii.gz" -d dmri_moco_dwi_mean.nii.gz -dseg dmri_moco_dwi_mean_seg.nii.gz -param step=1,type=seg,algo=centermass:step=2,type=seg,algo=bsplinesyn,metric=MeanSquares,smooth=1,iter=3 -initwarp ../t2/warp_template2anat.nii.gz -initwarpinv ../t2/warp_anat2template.nii.gz -qc "$SCT_BP_QC_FOLDER" -owarp warp_template2dmri.nii.gz -owarpinv warp_dmri2template.nii.gz
221|dmri|-|-|sct_warp_template -d dmri_moco_dwi_mean.nii.gz -w warp_template2dmri.nii.gz -qc "$SCT_BP_QC_FOLDER"
224|dmri|-|-|sct_dmri_compute_dti -i dmri_moco.nii.gz -bval bvals.txt -bvec bvecs.txt
226|dmri|-|-|sct_extract_metric -i dti_FA.nii.gz -z 2:14 -method wa -l 4,5 -o fa_in_cst.csv
228|dmri|-|-|sct_apply_transfo -i dti_FA.nii.gz -d "$SCT_DIR/data/PAM50/template/PAM50_t2.nii.gz" -w warp_dmri2template.nii.gz
237|fmri|-|-|sct_maths -i fmri.nii.gz -mean t -o fmri_mean.nii.gz
239|fmri|-|-|sct_get_centerline -i fmri_mean.nii.gz -c t2s
241|fmri|-|-|sct_create_mask -i fmri_mean.nii.gz -p centerline,fmri_mean_centerline.nii.gz -size 35mm
244|fmri|-|-|sct_fmri_moco -i fmri.nii.gz -g 1 -m mask_fmri_mean.nii.gz
250|fmri|-|-|sct_qc -i fmri.nii.gz -d fmri_moco.nii.gz -s fmri_crop_moco_mean_seg_manual.nii.gz -p sct_fmri_moco -qc "$SCT_BP_QC_FOLDER"
252|fmri|-|-|sct_register_multimodal -i "$SCT_DIR/data/PAM50/template/PAM50_t2.nii.gz" -iseg "$SCT_DIR/data/PAM50/template/PAM50_cord.nii.gz" -d fmri_moco_mean.nii.gz -dseg fmri_crop_moco_mean_seg_manual.nii.gz -param step=1,type=seg,algo=slicereg,metric=MeanSquares,smooth=2:step=2,type=im,algo=bsplinesyn,metric=MeanSquares,iter=5,gradStep=0.5 -initwarp ../t2/warp_template2anat.nii.gz -initwarpinv ../t2/warp_anat2template.nii.gz -qc "$SCT_BP_QC_FOLDER" -owarp warp_template2fmri.nii.gz -owarpinv warp_fmri2template.nii.gz
254|fmri|-|-|sct_warp_template -d fmri_moco_mean.nii.gz -w warp_template2fmri.nii.gz -a 0
`;

function parseCase(line) {
  const [sourceLine, section, taskId, contrast, command] = line.split('|');
  return {
    source: BATCH_PROCESSING_SOURCE,
    sourceLine: Number(sourceLine),
    section,
    taskId: taskId === '-' ? null : taskId,
    contrast: contrast === '-' ? null : contrast,
    command
  };
}

function classifyBatchStep(testCase) {
  const command = testCase.command;

  if (command.startsWith('sct_deepseg spinalcord -i ') || command.startsWith('sct_deepseg_gm -i ')) {
    return { status: 'webapp-feature', feature: 'segmentation' };
  }
  if (command.startsWith('sct_download_data')) return { status: 'browser-library', feature: 'sampleDataDownload' };
  if (command === 'sct_deepseg spinalcord -install') return { status: 'browser-library', feature: 'modelInstall' };
  if (command.startsWith('sct_get_centerline')) return { status: 'browser-library', feature: 'centerline' };
  if (command.startsWith('sct_label_utils')) return { status: 'browser-library', feature: 'labelUtils' };
  if (command.startsWith('sct_label_vertebrae')) return { status: 'browser-library', feature: 'vertebralLabeling' };
  if (
    command.startsWith('sct_register_to_template') ||
    command.startsWith('sct_register_multimodal') ||
    command.startsWith('sct_warp_template') ||
    command.startsWith('sct_apply_transfo')
  ) {
    return { status: 'browser-library', feature: 'templateRegistration' };
  }
  if (command.startsWith('sct_process_segmentation')) return { status: 'browser-library', feature: 'morphometry' };
  if (command.startsWith('sct_detect_pmj')) return { status: 'browser-library', feature: 'pmjDetection' };
  if (command.startsWith('sct_maths')) return { status: 'browser-library', feature: 'imageMath' };
  if (command.startsWith('sct_create_mask') || command.startsWith('sct_crop_image')) {
    return { status: 'browser-library', feature: 'maskCrop' };
  }
  if (command.startsWith('sct_smooth_spinalcord')) return { status: 'browser-library', feature: 'smoothing' };
  if (command.startsWith('sct_flatten_sagittal')) return { status: 'browser-library', feature: 'flattening' };
  if (command.startsWith('sct_compute_mtr') || command.startsWith('sct_compute_mtsat')) {
    return { status: 'browser-library', feature: 'mtMetrics' };
  }
  if (command.startsWith('sct_extract_metric')) return { status: 'browser-library', feature: 'metricExtraction' };
  if (command.startsWith('sct_dmri_separate_b0_and_dwi')) return { status: 'browser-library', feature: 'dmriSplit' };
  if (command.startsWith('sct_dmri_compute_dti')) return { status: 'browser-library', feature: 'dtiMetrics' };
  if (command.startsWith('sct_dmri_moco')) return { status: 'browser-library', feature: 'dmriMoco' };
  if (command.startsWith('sct_fmri_moco')) return { status: 'browser-library', feature: 'fmriPreprocessing' };
  if (command.startsWith('sct_qc')) return { status: 'browser-library', feature: 'qcReport' };

  throw new Error(`Unclassified batch processing step at line ${testCase.sourceLine}: ${command}`);
}

function assertHtmlControl(id) {
  assert.ok(indexHtml.includes(`id="${id}"`), `web/index.html exposes #${id}`);
}

function assertWorkerMessage(messageType) {
  const quoted = `'${messageType}'`;
  assert.ok(
    executorJs.includes(quoted) || workerJs.includes(quoted),
    `worker pipeline handles "${messageType}"`
  );
}

function assertWebappPipelineFeature(featureName) {
  const feature = WEBAPP_PIPELINE_FEATURES[featureName];
  assert.ok(feature, `known webapp feature: ${featureName}`);
  for (const control of feature.controls) assertHtmlControl(control);
  for (const message of feature.workerMessages) assertWorkerMessage(message);
  for (const label of feature.labels) {
    assert.ok(indexHtml.includes(label) || appJs.includes(label), `webapp displays "${label}"`);
  }
}

function assertSegmentationTaskMapping(testCase) {
  const task = tasksById.get(testCase.taskId);
  assert.ok(task, `${testCase.taskId} exists in web/models/manifest.json`);
  assert.ok(
    SUPPORTED_TASK_STATUSES.has(task.supportStatus),
    `${testCase.taskId} has a browser workflow support status`
  );
  assert.ok(
    task.inputContrasts.includes(testCase.contrast),
    `${testCase.taskId} includes ${testCase.contrast} for ${testCase.section}:${testCase.sourceLine}`
  );

  if (task.supportStatus === 'supported') {
    assert.equal(task.validationStatus, 'passed', `${testCase.taskId} cannot be supported without passed validation`);
    assert.ok(task.modelAssets?.some(asset => ['native', 'converted'].includes(asset.conversionStatus)),
      `${testCase.taskId} must have a runnable browser asset when supported`);
  } else {
    assert.notEqual(task.validationStatus, 'passed', `${testCase.taskId} is not supported and must not claim passed validation`);
    assert.ok(task.unsupportedReason, `${testCase.taskId} needs a reason while it cannot run the SCT batch case`);
  }
}

function assertBrowserLibraryFeature(featureName) {
  const functionNames = BROWSER_LIBRARY_FEATURES[featureName];
  assert.ok(functionNames, `known browser library feature: ${featureName}`);
  const moduleSource = fs.readFileSync(path.join(ROOT, 'web/js/modules/sct-processing.js'), 'utf8');
  for (const functionName of functionNames) {
    assert.ok(moduleSource.includes(`function ${functionName}`), `sct-processing implements ${functionName}`);
  }
}

const cases = RAW_CASES.trim().split('\n').map(parseCase);
const tasksById = new Map(manifest.tasks.map(task => [task.id, task]));
const browserSegmentationRegex = /^sct_(deepseg spinalcord|deepseg_gm)\b/;

assert.equal(cases.length, 62, 'all active SCT commands in batch_processing.sh are represented');
assert.equal(new Set(cases.map(testCase => testCase.sourceLine)).size, cases.length, 'source lines are unique');
for (const featureName of Object.keys(WEBAPP_PIPELINE_FEATURES)) {
  assertWebappPipelineFeature(featureName);
}

for (const testCase of cases) {
  assert.match(testCase.command, /^sct_/, `${testCase.section}:${testCase.sourceLine} is an active SCT command`);
  const classification = classifyBatchStep(testCase);

  const shouldMapToBrowserTask = browserSegmentationRegex.test(testCase.command) && !testCase.command.includes(' -install');
  assert.equal(
    Boolean(testCase.taskId),
    shouldMapToBrowserTask,
    `${testCase.section}:${testCase.sourceLine} browser task mapping matches command type`
  );

  if (classification.status === 'webapp-feature') {
    assert.equal(classification.feature, 'segmentation');
    assertWebappPipelineFeature(classification.feature);
    assertSegmentationTaskMapping(testCase);
  } else if (classification.status === 'browser-library') {
    assertBrowserLibraryFeature(classification.feature);
    assert.equal(testCase.taskId, null, `${testCase.section}:${testCase.sourceLine} is implemented as a library feature, not a task selector model`);
  } else {
    assert.ok(NATIVE_ONLY_FEATURES[classification.feature], `native-only rationale exists for ${classification.feature}`);
    assert.equal(testCase.taskId, null, `${testCase.section}:${testCase.sourceLine} must not be presented as a runnable browser task`);
  }
}

const webappMappedCases = cases.filter(testCase => classifyBatchStep(testCase).status === 'webapp-feature');
const browserLibraryCases = cases.filter(testCase => classifyBatchStep(testCase).status === 'browser-library');
const nativeOnlyCases = cases.length - webappMappedCases.length - browserLibraryCases.length;
console.log(`Batch processing webapp tests passed: ${cases.length} commands, ${webappMappedCases.length} segmentation feature cases, ${browserLibraryCases.length} browser-library cases, ${nativeOnlyCases} native-only steps guarded`);
