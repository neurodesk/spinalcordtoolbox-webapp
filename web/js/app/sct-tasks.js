import { VERSION, MODEL_BASE_URL } from './config.js';

export const SCT_STABLE_SOURCE = 'https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html';

export const TASK_STATUS = Object.freeze({
  SUPPORTED: 'supported',
  UNVALIDATED: 'unvalidated',
  UNSUPPORTED: 'unsupported',
  RETIRED: 'retired'
});

export const SCT_LABELS = Object.freeze({
  spinalcord: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'No spinal cord' },
    { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255], meaning: 'Spinal cord segmentation' }
  ],
  graymatter: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'No gray matter' },
    { index: 1, name: 'Gray matter', color: [255, 184, 76, 255], meaning: 'Spinal cord gray matter' }
  ],
  lesion: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'No lesion' },
    { index: 1, name: 'Lesion', color: [255, 66, 120, 255], meaning: 'Spinal cord lesion' }
  ],
  multiclass: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'Background' },
    { index: 1, name: 'Class 1', color: [68, 128, 255, 255], meaning: 'Task-defined class 1' },
    { index: 2, name: 'Class 2', color: [255, 184, 76, 255], meaning: 'Task-defined class 2' },
    { index: 3, name: 'Class 3', color: [255, 66, 120, 255], meaning: 'Task-defined class 3' }
  ]
});

export const SCT_TASKS = [
  {
    id: 'spinalcord',
    displayName: 'Spinal cord',
    category: 'spinal-cord',
    description: 'Contrast-agnostic spinal cord segmentation from SCT stable.',
    inputContrasts: ['T1w', 'T2w', 'T2star', 'MT', 'DWI', 'MP2RAGE', 'PSIR', 'STIR', 'EPI'],
    requiredInputs: [{ role: 'image', contrast: 'any supported spinal cord MRI contrast' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.SUPPORTED,
    validationStatus: 'passed',
    validationSummary: 'Converted SCT stable contrast-agnostic nnUNet package to ONNX and validated against the batch-processing fixture outputs.',
    modelAssets: [
      {
        id: 'sct-spinalcord',
        sourceUrl: 'https://spinalcordtoolbox.com/stable/user_section/command-line/deepseg/spinalcord.html',
        sourceVersion: 'stable',
        sourceFormat: 'SCT model package',
        browserFormat: 'onnx',
        filename: 'sct-spinalcord.onnx',
        conversionStatus: 'converted',
        checksum: 'sha256:5ada810b71b1ad6f445b805af899bd4f6c08f85045927450dc20d2395c1beddd',
        sizeBytes: 123468139,
        patchSize: [160, 224, 64],
        inferenceDefaults: {
          probabilityThreshold: 0.5,
          minComponentSize: 10,
          testTimeAugmentation: true
        }
      }
    ]
  },
  {
    id: 'sc_lumbar_t2',
    displayName: 'Lumbar spinal cord T2',
    category: 'spinal-cord',
    description: 'Lumbar-region spinal cord segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w lumbar spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'sc_epi',
    displayName: 'Spinal cord EPI',
    category: 'spinal-cord',
    description: 'Spinal cord segmentation for EPI-BOLD fMRI images.',
    inputContrasts: ['EPI'],
    requiredInputs: [{ role: 'image', contrast: 'EPI-BOLD fMRI' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'sc_mouse_t1',
    displayName: 'Mouse spinal cord T1',
    category: 'spinal-cord',
    description: 'Mouse spinal cord segmentation for T1-weighted data.',
    inputContrasts: ['T1w'],
    requiredInputs: [{ role: 'image', contrast: 'mouse T1w spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'graymatter',
    displayName: 'Gray matter',
    category: 'gray-matter',
    description: 'Spinal cord gray matter segmentation.',
    inputContrasts: ['T2star'],
    requiredInputs: [{ role: 'image', contrast: 'T2star spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'graymatter',
    supportStatus: TASK_STATUS.SUPPORTED,
    validationStatus: 'passed',
    validationSummary: 'Converted SCT stable gray matter nnUNet package to an ONNX browser wrapper and validated against the T2star batch fixture.',
    modelAssets: [
      {
        id: 'sct-graymatter',
        sourceUrl: 'https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html',
        sourceVersion: 'stable',
        sourceFormat: 'SCT model package',
        browserFormat: 'onnx',
        filename: 'sct-graymatter.onnx',
        conversionStatus: 'converted',
        checksum: 'sha256:73c1d741aa2f2f38555e250b0d69b95ae72f8d69b56c162c424985660e705897',
        sizeBytes: 134270580,
        patchSize: [64, 64, 64],
        inferenceDefaults: {
          probabilityThreshold: 0.5,
          minComponentSize: 10,
          testTimeAugmentation: false
        }
      }
    ]
  },
  {
    id: 'gm_sc_7t_t2star',
    displayName: 'Gray matter 7T T2star',
    category: 'gray-matter',
    description: 'Spinal cord gray matter segmentation for 7T T2star data.',
    inputContrasts: ['T2star'],
    requiredInputs: [{ role: 'image', contrast: '7T T2star spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'graymatter',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'gm_wm_exvivo_t2',
    displayName: 'Ex vivo gray/white matter T2',
    category: 'gray-matter',
    description: 'Ex vivo spinal cord gray and white matter segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'ex vivo T2w spinal cord MRI' }],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'gm_wm_mouse_t1',
    displayName: 'Mouse gray/white matter T1',
    category: 'gray-matter',
    description: 'Mouse spinal cord gray and white matter segmentation for T1-weighted data.',
    inputContrasts: ['T1w'],
    requiredInputs: [{ role: 'image', contrast: 'mouse T1w spinal cord MRI' }],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'gm_mouse_t1',
    displayName: 'Mouse gray matter T1',
    category: 'gray-matter',
    description: 'Mouse spinal cord gray matter segmentation for T1-weighted data.',
    inputContrasts: ['T1w'],
    requiredInputs: [{ role: 'image', contrast: 'mouse T1w spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'graymatter',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'lesion_sci_t2',
    displayName: 'SCI lesion T2',
    category: 'pathology',
    description: 'Spinal cord injury lesion segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w spinal cord injury MRI' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'lesion_ms',
    displayName: 'MS lesion',
    category: 'pathology',
    description: 'Contrast-agnostic multiple sclerosis lesion segmentation.',
    inputContrasts: ['T1w', 'T2w', 'T2star', 'MP2RAGE', 'PSIR', 'STIR'],
    requiredInputs: [{ role: 'image', contrast: 'supported MS spinal cord MRI contrast' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'lesion_ms_axial_t2',
    displayName: 'MS lesion axial T2',
    category: 'pathology',
    description: 'Multiple sclerosis lesion segmentation for axial T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'axial T2w spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'lesion_ms_mp2rage',
    displayName: 'MS lesion MP2RAGE',
    category: 'pathology',
    description: 'Multiple sclerosis lesion segmentation for MP2RAGE data.',
    inputContrasts: ['MP2RAGE'],
    requiredInputs: [{ role: 'image', contrast: 'MP2RAGE spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'tumor_edema_cavity_t1_t2',
    displayName: 'Tumor, edema, cavity',
    category: 'pathology',
    description: 'Multiclass spinal cord tumor, edema, and cavity segmentation.',
    inputContrasts: ['T1w', 'T2w'],
    requiredInputs: [
      { role: 'image', contrast: 'T1w' },
      { role: 'image', contrast: 'T2w' }
    ],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Requires multi-input workflow support before browser execution can be enabled.',
    modelAssets: []
  },
  {
    id: 'tumor_t2',
    displayName: 'Tumor T2',
    category: 'pathology',
    description: 'Spinal cord tumor segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w spinal cord tumor MRI' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'rootlets',
    displayName: 'Rootlets',
    category: 'other-structure',
    description: 'Spinal nerve rootlet segmentation.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w' }],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'spine',
    displayName: 'Spine',
    category: 'other-structure',
    description: 'Spine structure segmentation from SCT stable.',
    inputContrasts: ['CT', 'MRI'],
    requiredInputs: [{ role: 'image', contrast: 'supported spine image' }],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'sc_canal_t2',
    displayName: 'Spinal canal T2',
    category: 'other-structure',
    description: 'Spinal canal segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'seg_sc_ms_lesion_stir_psir',
    displayName: 'Retired STIR/PSIR MS lesion',
    category: 'retired',
    description: 'Retired STIR/PSIR MS lesion model.',
    inputContrasts: ['STIR', 'PSIR'],
    requiredInputs: [{ role: 'image', contrast: 'STIR or PSIR spinal cord MRI' }],
    outputType: 'unsupported',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.RETIRED,
    validationStatus: 'not-run',
    unsupportedReason: 'Retired by SCT stable; use lesion_ms instead.',
    modelAssets: []
  },
  {
    id: 'ms_sc_mp2rage',
    displayName: 'Retired MP2RAGE spinal cord',
    category: 'retired',
    description: 'Retired MP2RAGE spinal cord model.',
    inputContrasts: ['MP2RAGE'],
    requiredInputs: [{ role: 'image', contrast: 'MP2RAGE spinal cord MRI' }],
    outputType: 'unsupported',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.RETIRED,
    validationStatus: 'not-run',
    unsupportedReason: 'Retired by SCT stable; use spinalcord instead.',
    modelAssets: []
  },
  {
    id: 'sc_t2star',
    displayName: 'Retired T2star spinal cord',
    category: 'retired',
    description: 'Retired contrast-specific T2star spinal cord model.',
    inputContrasts: ['T2star'],
    requiredInputs: [{ role: 'image', contrast: 'T2star' }],
    outputType: 'unsupported',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.RETIRED,
    validationStatus: 'not-run',
    unsupportedReason: 'Retired by SCT stable; use spinalcord or sc_epi depending on data.',
    modelAssets: []
  }
];

export const DEFAULT_TASK_ID = 'spinalcord';

export function getTaskById(taskId) {
  return SCT_TASKS.find(task => task.id === taskId) || getDefaultTask();
}

export function getDefaultTask() {
  return SCT_TASKS.find(task => task.id === DEFAULT_TASK_ID) || SCT_TASKS[0];
}

export function getTaskLabels(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return SCT_LABELS[task?.labelSet || 'spinalcord'] || SCT_LABELS.spinalcord;
}

export function getTaskForegroundLabel(taskOrId) {
  return getTaskLabels(taskOrId).find(label => label.index > 0) || getTaskLabels(taskOrId)[0];
}

export function isTaskRunnable(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return task?.supportStatus === TASK_STATUS.SUPPORTED;
}

export function getPrimaryModelAsset(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return task?.modelAssets?.[0] || null;
}

export function getModelCacheKey(taskOrId, asset = getPrimaryModelAsset(taskOrId)) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  const assetId = asset?.id || 'no-asset';
  const version = asset?.sourceVersion || 'unknown';
  return `${task?.id || DEFAULT_TASK_ID}:${assetId}:${version}:app-${VERSION}`;
}

export function taskToManifestTask(task) {
  const labels = getTaskLabels(task).map(label => ({
    index: label.index,
    name: label.name,
    rgba: label.rgba || label.color
  }));
  const modelAssets = (task.modelAssets || []).map(asset => ({
    ...asset,
    cacheKey: getModelCacheKey(task, asset)
  }));
  return {
    ...task,
    labels,
    modelAssets
  };
}

export function buildManifest() {
  return {
    schemaVersion: '1.0.0',
    sctStableSource: SCT_STABLE_SOURCE,
    generatedAt: new Date().toISOString(),
    tasks: SCT_TASKS.map(taskToManifestTask)
  };
}

export function getTaskModelUrl(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  const asset = getPrimaryModelAsset(task);
  if (!asset?.filename) return null;
  return `${MODEL_BASE_URL}/${asset.filename}`;
}
