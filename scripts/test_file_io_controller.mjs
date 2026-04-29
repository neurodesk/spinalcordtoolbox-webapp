#!/usr/bin/env node

import assert from 'node:assert/strict';

// FileIOController imports DicomController which dynamically imports the dcm2niix
// WASM module on demand. We never trigger that path in these tests (no DICOM
// inputs go through), so we can import FileIOController directly and stub the
// document/File globals that its constructor and helpers touch.

class FakeClassList {
  constructor() { this.classes = new Set(); }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  contains(c) { return this.classes.has(c); }
}

function makeStubElement() {
  return {
    classList: new FakeClassList(),
    innerHTML: '',
    value: '',
    children: [],
    appendChild(child) { this.children.push(child); },
    querySelector() { return { textContent: '' }; }
  };
}

function installFakeDom() {
  const elements = new Map();
  const ensure = (id) => {
    if (!elements.has(id)) elements.set(id, makeStubElement());
    return elements.get(id);
  };
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: () => makeStubElement(),
    _ensure: ensure,
    _elements: elements
  };
  // Pre-create the elements FileIOController touches.
  ensure('inputDropZone');
  ensure('fileList');
  ensure('fileInput');
  return elements;
}

function makeFile(name) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
}

const elements = installFakeDom();

const { FileIOController } = await import('../web/js/controllers/FileIOController.js');

// Test 1: NIfTI single-file path
{
  const log = [];
  const loaded = [];
  const ctl = new FileIOController({
    updateOutput: (m) => log.push(m),
    onFileLoaded: (f) => loaded.push(f.name)
  });

  ctl.handleFiles([makeFile('scan.nii.gz')]);
  assert.equal(ctl.hasValidData(), true);
  assert.equal(ctl.getActiveFile().name, 'scan.nii.gz');
  assert.deepEqual(loaded, ['scan.nii.gz']);
  assert.ok(log.some(m => m.includes('scan.nii.gz')), 'logs the loaded filename');
  assert.equal(elements.get('inputDropZone').classList.contains('has-files'), true);
}

// Test 2: empty/null inputs are no-ops
{
  const ctl = new FileIOController({});
  ctl.handleFiles([]);
  ctl.handleFiles(null);
  ctl.handleDropItems([]);
  ctl.handleDropItems(null);
  assert.equal(ctl.hasValidData(), false);
  assert.equal(ctl.getActiveFile(), null);
}

// Test 3: NIfTI detection picks .nii.gz out of a mixed list
{
  const ctl = new FileIOController({});
  ctl.handleFiles([
    makeFile('readme.txt'),
    makeFile('scan.nii.gz'),
    makeFile('extra.dcm')
  ]);
  assert.equal(ctl.getActiveFile().name, 'scan.nii.gz');
}

// Test 4: clearFiles resets state and DOM
{
  const ctl = new FileIOController({});
  ctl.handleFiles([makeFile('scan.nii')]);
  assert.equal(ctl.hasValidData(), true);
  ctl.clearFiles();
  assert.equal(ctl.hasValidData(), false);
  assert.equal(ctl.getActiveFile(), null);
  assert.equal(elements.get('inputDropZone').classList.contains('has-files'), false);
  assert.equal(elements.get('fileInput').value, '');
}

// Test 5: non-NIfTI list dispatches to DICOM controller (we observe via the
// updateOutput message and confirm state was *not* set on FileIOController).
{
  const log = [];
  const ctl = new FileIOController({ updateOutput: (m) => log.push(m) });
  // Stub out the dicom dispatch so we don't load WASM.
  let dicomCalled = false;
  ctl.dicomController.convertFiles = async () => { dicomCalled = true; };

  ctl.handleFiles([makeFile('image1.dcm'), makeFile('image2.dcm')]);
  assert.equal(dicomCalled, true, 'DICOM converter was invoked');
  assert.equal(ctl.hasValidData(), false, 'no NIfTI file loaded yet');
  assert.ok(log.some(m => m.includes('DICOM input')), 'logs DICOM detection');
}

// Test 6: handleDropItems with a NIfTI item routes through handleFiles
{
  const ctl = new FileIOController({});
  const file = makeFile('drop.nii.gz');
  const dataTransfer = [{ getAsFile: () => file }];
  ctl.handleDropItems(dataTransfer);
  assert.equal(ctl.getActiveFile().name, 'drop.nii.gz');
}

// Test 7: handleDropItems without NIfTI files goes to DICOM
{
  const ctl = new FileIOController({});
  let dropDicomCalled = false;
  ctl.dicomController.convertDropItems = async () => { dropDicomCalled = true; };
  ctl.handleDropItems([{ getAsFile: () => makeFile('img.dcm') }]);
  assert.equal(dropDicomCalled, true);
  assert.equal(ctl.hasValidData(), false);
}

console.log('FileIOController tests passed');
