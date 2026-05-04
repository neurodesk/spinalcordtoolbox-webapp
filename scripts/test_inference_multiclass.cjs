#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const pipeline = require('../web/js/inference-pipeline.js');

(async () => {
  {
    const logits = new Float32Array([
      2, 0,
      0, 2,
      -2, -2
    ]);
    const probs = pipeline.softmaxChannels(logits, 3);
    for (let i = 0; i < 2; i++) {
      const sum = probs[i] + probs[2 + i] + probs[4 + i];
      assert.ok(Math.abs(sum - 1) < 1e-6, 'softmax probabilities sum to one per voxel');
    }
    assert.deepEqual([...pipeline.argmaxLabelsFromChannels(probs, 3, [0, 1, 2])], [0, 1]);
  }

  {
    const labels = new Uint8Array([0, 1, 2, 3, 2]);
    const split = pipeline.splitLabelsByClassMap(labels, [
      { stage: 'segmentation', labels: [1, 2] },
      { stage: 'lesion', labels: [2] }
    ]);
    assert.deepEqual([...split.segmentation], [0, 1, 1, 0, 1]);
    assert.deepEqual([...split.lesion], [0, 0, 1, 0, 1]);
  }

  {
    const result = await pipeline.runRegionInferencePipeline(
      {
        data: new Float32Array([0, 0, 0, 0]),
        dims: [2, 2, 1],
        patchSize: [2, 2, 1]
      },
      async () => new Float32Array([
        10, 10, -10, -10,
        -10, -10, 10, 10
      ]),
      {
        normalizeInput: false,
        threshold: 0.5,
        minComponentSize: 1,
        channelCount: 2,
        regions: [
          { name: 'sc', stage: 'segmentation', channel: 0, sourceLabels: [1, 2], outputLabel: 1 },
          { name: 'lesion', stage: 'lesion', channel: 1, sourceLabels: [2], outputLabel: 1 }
        ]
      }
    );
    assert.deepEqual(result.regions.map(region => region.stage), ['segmentation', 'lesion']);
    assert.deepEqual([...result.regions[0].labels], [1, 0, 1, 0]);
    assert.deepEqual([...result.regions[1].labels], [0, 1, 0, 1]);
  }

  {
    const result = await pipeline.runInferencePipeline(
      {
        data: new Float32Array([0, 0, 0, 0]),
        dims: [2, 2, 1],
        patchSize: [2, 2, 1]
      },
      async () => new Float32Array([10, 10, -10, -10]),
      { normalizeInput: false, threshold: 0.5, minComponentSize: 1 }
    );
    assert.deepEqual([...result.labels], [1, 0, 1, 0], 'binary sigmoid inference output stays unchanged');
  }

  console.log('Inference post-processing tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
