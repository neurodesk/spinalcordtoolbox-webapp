/**
 * ViewerController
 *
 * Manages NiiVue visualization with support for base volume and segmentation overlays.
 * Manages SCT task colormaps.
 */

export class ViewerController {
  constructor(options) {
    this.nv = options.nv;
    this.updateOutput = options.updateOutput || (() => {});
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.sctColormapsRegistered = new Set();
  }

  /**
   * Register an SCT discrete colormap with NiiVue.
   * @param {Object} colormapData - { R, G, B, A } arrays from labels.js
   */
  registerSctColormap(colormapData, colormapId = 'sct-spinalcord') {
    try {
      this.nv.addColormap(colormapId, colormapData);
      this.sctColormapsRegistered.add(colormapId);
    } catch (e) {
      console.warn(`Could not register ${colormapId} colormap:`, e);
    }
  }

  registerVesselColormap(colormapData) {
    this.registerSctColormap(colormapData, 'sct-spinalcord');
  }

  async loadBaseVolume(file) {
    try {
      this.updateOutput(`Loading ${file.name}...`);
      const url = URL.createObjectURL(file);
      await this.nv.loadVolumes([{ url: url, name: file.name }]);
      URL.revokeObjectURL(url);
      this.currentBaseFile = file;
      this.currentOverlayFile = null;
      this.currentOverlayIndex = null;
      this.updateOutput(`${file.name} loaded`);
    } catch (error) {
      this.updateOutput(`Error loading ${file.name}: ${error.message}`);
      console.error(error);
    }
  }

  clearVolumes() {
    this.nv.volumes = [];
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.nv.updateGLVolume();
    this.nv.drawScene?.();
  }

  clearOverlay() {
    const overlayIndex = this.getOverlayIndex();
    if (overlayIndex === null) return;

    if (typeof this.nv.removeVolumeByIndex === 'function') {
      this.nv.removeVolumeByIndex(overlayIndex);
    } else {
      this.nv.volumes.splice(overlayIndex, 1);
      this.nv.updateGLVolume();
      this.nv.drawScene?.();
    }

    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
  }

  configureSegmentationVolume(index, colormap) {
    const volume = this.nv.volumes[index];
    if (!volume) return;

    volume.cal_min = 0;
    volume.cal_max = Math.max(1, volume.global_max ?? 1);
    volume.colormap = colormap;
    if (typeof this.nv.setColormap === 'function' && volume.id) {
      this.nv.setColormap(volume.id, colormap);
    }
  }

  async loadOverlay(file, colormap = 'red', opacity = 0.5) {
    try {
      this.clearOverlay();

      const url = URL.createObjectURL(file);
      await this.nv.addVolumeFromUrl({
        url: url,
        name: file.name,
        colormap: colormap,
        opacity,
        visible: true,
        cal_min: 0,
        cal_max: 1
      });
      URL.revokeObjectURL(url);

      const overlayIndex = this.nv.volumes.length - 1;
      if (overlayIndex > 0) {
        this.configureSegmentationVolume(overlayIndex, colormap);
        this.nv.setOpacity(overlayIndex, opacity);
        this.nv.updateGLVolume();
      }

      this.currentOverlayFile = file;
      this.currentOverlayIndex = overlayIndex > 0 ? overlayIndex : null;
    } catch (error) {
      this.updateOutput(`Error loading overlay: ${error.message}`);
      console.error(error);
    }
  }

  async loadSegmentationAsBase(file, colormap = 'sct-spinalcord') {
    await this.loadBaseVolume(file);
    this.configureSegmentationVolume(0, colormap);
    this.currentBaseFile = file;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.nv.updateGLVolume();
    this.nv.drawScene?.();
  }

  async showResultAsOverlay(baseFile, overlayFile, colormap = 'sct-spinalcord') {
    await this.loadBaseVolume(baseFile);
    if (overlayFile) {
      await this.loadOverlay(overlayFile, colormap);
    }
  }

  setViewType(type) {
    const typeMap = {
      multiplanar: this.nv.sliceTypeMultiplanar,
      axial: this.nv.sliceTypeAxial,
      coronal: this.nv.sliceTypeCoronal,
      sagittal: this.nv.sliceTypeSagittal,
      render: this.nv.sliceTypeRender
    };
    if (typeMap[type] !== undefined) {
      this.nv.setSliceType(typeMap[type]);
    }
  }

  setBaseOpacity(value) {
    if (this.nv.volumes.length > 0) {
      this.nv.setOpacity(0, value);
      this.nv.updateGLVolume();
    }
  }

  setOverlayOpacity(value) {
    const overlayIndex = this.getOverlayIndex();
    if (overlayIndex !== null) {
      this.nv.setOpacity(overlayIndex, value);
      this.nv.updateGLVolume();
    }
  }

  setOverlayColormap(colormap) {
    const overlayIndex = this.getOverlayIndex();
    if (overlayIndex !== null) {
      const overlay = this.nv.volumes[overlayIndex];
      overlay.colormap = colormap;
      if (typeof this.nv.setColormap === 'function' && overlay.id) {
        this.nv.setColormap(overlay.id, colormap);
      }
      this.nv.updateGLVolume();
    }
  }

  getOverlayIndex() {
    if (this.currentOverlayIndex !== null && this.nv.volumes[this.currentOverlayIndex]) {
      return this.currentOverlayIndex;
    }
    return this.nv.volumes.length > 1 ? this.nv.volumes.length - 1 : null;
  }

  getCurrentFile() {
    return this.currentBaseFile;
  }
}
