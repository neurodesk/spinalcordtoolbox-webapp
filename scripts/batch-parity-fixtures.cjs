'use strict';

const DEFAULT_NIFTI_POLICY = Object.freeze({
  dataComparison: 'exact',
  metadataFields: Object.freeze([
    'dimensions',
    'spacing',
    'affine_or_orientation',
    'datatype',
    'label_semantics',
    'output_name'
  ]),
  labelSemantics: 'binary-segmentation'
});

const FIXTURE_CASES = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    batchStep: { section: 't2', sourceLine: 72 },
    inputPath: 'test_data/batch_t2_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t2_label_vertebrae',
    batchStep: { section: 't2', sourceLine: 81 },
    inputPath: 'test_data/batch_t2_label_vertebrae/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2_label_vertebrae/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t2s_deepseg_spinalcord',
    batchStep: { section: 't2s', sourceLine: 114 },
    inputPath: 'test_data/batch_t2s_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2s_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    batchStep: { section: 't2s', sourceLine: 116 },
    inputPath: 'test_data/batch_t2s_deepseg_graymatter/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2s_deepseg_graymatter/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t1',
    batchStep: { section: 't1', sourceLine: 141 },
    inputPath: 'test_data/batch_t1_deepseg_spinalcord_t1/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t1_deepseg_spinalcord_t1/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t2',
    batchStep: { section: 't1', sourceLine: 146 },
    inputPath: 'test_data/batch_t1_deepseg_spinalcord_t2/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t1_deepseg_spinalcord_t2/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_mt_deepseg_spinalcord',
    batchStep: { section: 'mt', sourceLine: 172 },
    inputPath: 'test_data/batch_mt_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_mt_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    batchStep: { section: 'dmri', sourceLine: 214 },
    inputPath: 'test_data/batch_dmri_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_dmri_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  }
]);

module.exports = {
  DEFAULT_NIFTI_POLICY,
  FIXTURE_CASES
};
