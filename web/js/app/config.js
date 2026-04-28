export const VERSION = '7.1.0';

// Model - relative path (served from same origin)
export const MODEL_BASE_URL = './models';

export const MODEL = {
  name: 'sct-spinalcord.onnx',
  label: 'SCT spinalcord',
  numClasses: 1,
  patchSize: [64, 64, 64]
};

// Available SCT task entries. Runtime details are defined in sct-tasks.js.
export const MODELS = [
  {
    id: 'spinalcord',
    name: 'sct-spinalcord.onnx',
    label: 'Spinal cord',
    description: 'SCT stable contrast-agnostic spinal cord segmentation. Requires converted browser model validation before execution.',
    numClasses: 1,
    patchSize: [64, 64, 64],
    supportStatus: 'unvalidated'
  }
];

export const SYNTHSTRIP_MODEL = {
  name: 'synthstrip.onnx',
  label: 'SynthStrip',
  targetSpacing: [1.0, 1.0, 1.0]
};

export const SYNTHSTRIP_FAST_MODEL = {
  name: 'synthstrip.onnx',
  label: 'SynthStrip Fast',
  targetSpacing: [2.0, 2.0, 2.0]
};

export const INFERENCE_DEFAULTS = {
  cropForegroundMargin: 20,
  overlap: 0,
  probabilityThreshold: 0.1,
  minComponentSize: 10,
  biasCorrection: true,
  denoising: false,
  fractionalIntensity: 0.5
};

export const VIEWER_CONFIG = {
  loadingText: "",
  dragToMeasure: false,
  isColorbar: false,
  textHeight: 0.03,
  show3Dcrosshair: false,
  crosshairColor: [0.23, 0.51, 0.96, 1.0],
  crosshairWidth: 0.75
};

export const PROGRESS_CONFIG = {
  animationSpeed: 0.5
};

export const STAGE_NAMES = {
  'input': 'Input',
  'downsample': 'Downsample',
  'bet': 'Brain Extraction',
  'n4': 'Bias Correction',
  'nlm': 'Denoising',
  'segmentation': 'SCT Segmentation'
};

export const ONNX_CONFIG = {
  executionProviders: ['webgpu', 'wasm'],
  graphOptimizationLevel: 'all'
};

export const CACHE_CONFIG = {
  name: 'SCTModelCache',
  storeName: 'models',
  maxSizeMB: 500
};

export const PIPELINE_STEPS = ['load', 'downsample', 'n4', 'denoise', 'inference', 'bet'];

if (typeof self !== 'undefined') self.SpinalCordToolboxConfig = { VERSION, MODEL_BASE_URL, MODEL, MODELS, SYNTHSTRIP_MODEL, SYNTHSTRIP_FAST_MODEL, INFERENCE_DEFAULTS, VIEWER_CONFIG, PROGRESS_CONFIG, STAGE_NAMES, ONNX_CONFIG, CACHE_CONFIG, PIPELINE_STEPS };
