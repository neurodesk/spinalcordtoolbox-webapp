#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ViewerController } from '../web/js/controllers/ViewerController.js';

function createFakeNiivue() {
  return {
    volumes: [{ name: 'input.nii', opacity: 1 }],
    removedIndexes: [],
    opacityCalls: [],
    updateCount: 0,
    drawCount: 0,
    addColormap() {},
    async loadVolumes(volumes) {
      this.volumes = volumes.map(volume => ({
        id: volume.name,
        name: volume.name,
        colormap: volume.colormap || 'gray',
        opacity: volume.opacity ?? 1,
        global_max: 1
      }));
    },
    async addVolumeFromUrl(volume) {
      this.volumes.push({
        id: volume.name,
        name: volume.name,
        colormap: volume.colormap,
        opacity: volume.opacity,
        global_max: 1
      });
    },
    removeVolumeByIndex(index) {
      this.removedIndexes.push(index);
      this.volumes.splice(index, 1);
    },
    setOpacity(index, value) {
      this.opacityCalls.push([index, value]);
      this.volumes[index].opacity = value;
    },
    setColormap(id, colormap) {
      const volume = this.volumes.find(item => item.id === id);
      if (volume) volume.colormap = colormap;
    },
    updateGLVolume() {
      this.updateCount += 1;
    },
    drawScene() {
      this.drawCount += 1;
    }
  };
}

function makeFile(name) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  await viewer.loadOverlay(makeFile('first_seg.nii'), 'sct-spinalcord', 0.5);
  await viewer.loadOverlay(makeFile('second_seg.nii'), 'sct-spinalcord', 0.35);

  assert.equal(nv.volumes.length, 2);
  assert.equal(nv.volumes[0].name, 'input.nii');
  assert.equal(nv.volumes[1].name, 'second_seg.nii');
  assert.deepEqual(nv.removedIndexes, [1]);
  assert.deepEqual(nv.opacityCalls.at(-1), [1, 0.35]);
  assert.equal(viewer.getOverlayIndex(), 1);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  await viewer.loadOverlay(makeFile('seg.nii'), 'sct-spinalcord', 0.5);
  viewer.setBaseOpacity(0);

  assert.equal(nv.volumes[0].opacity, 0);
  assert.equal(nv.volumes[1].opacity, 0.5);
  assert.deepEqual(nv.opacityCalls.at(-1), [0, 0]);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  await viewer.loadOverlay(makeFile('seg_overlay.nii'), 'sct-spinalcord', 0.5);
  await viewer.loadSegmentationAsBase(makeFile('seg_base.nii'), 'sct-spinalcord');

  assert.equal(nv.volumes.length, 1);
  assert.equal(nv.volumes[0].name, 'seg_base.nii');
  assert.equal(nv.volumes[0].colormap, 'sct-spinalcord');
  assert.equal(nv.volumes[0].cal_min, 0);
  assert.equal(nv.volumes[0].cal_max, 1);
  assert.equal(viewer.getOverlayIndex(), null);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  nv.volumes.push({
    id: 'vertebrae.nii',
    name: 'vertebrae.nii',
    colormap: 'sct-vertebrae',
    opacity: 0.7,
    global_max: 1,
    img: new Uint8Array([0, 1, 5, 11])
  });
  viewer.configureSegmentationVolume(1, 'sct-vertebrae');

  assert.equal(nv.volumes[1].cal_min, 0);
  assert.equal(nv.volumes[1].cal_max, 11);
  assert.equal(nv.volumes[1].colormap, 'sct-vertebrae');
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });
  const input = makeFile('input_roundtrip.nii');
  const seg = makeFile('seg_roundtrip.nii');

  await viewer.loadBaseVolume(input);
  await viewer.loadOverlay(seg, 'sct-spinalcord', 0.45);
  await viewer.loadSegmentationAsBase(seg, 'sct-spinalcord');
  await viewer.loadBaseVolume(input);
  await viewer.loadOverlay(seg, 'sct-spinalcord', 0.45);

  assert.equal(nv.volumes.length, 2);
  assert.equal(nv.volumes[0].name, 'input_roundtrip.nii');
  assert.equal(nv.volumes[1].name, 'seg_roundtrip.nii');
  assert.equal(nv.volumes[0].opacity, 1);
  assert.equal(nv.volumes[1].opacity, 0.45);
  assert.equal(viewer.getOverlayIndex(), 1);
}

console.log('ViewerController tests passed');
