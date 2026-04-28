import { getTaskLabels } from './sct-tasks.js';

export const LABELS = Object.freeze([
  { index: 0, name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255] },
]);

/**
 * Generate a NiiVue-compatible discrete colormap LUT.
 * Returns an object { R, G, B, A, min, max } for nv.addColormap().
 */
export function generateNiivueColormap(taskId = 'spinalcord') {
  const labels = getTaskLabels(taskId);
  const size = 256;
  const R = new Array(size).fill(0);
  const G = new Array(size).fill(0);
  const B = new Array(size).fill(0);
  const A = new Array(size).fill(0);

  const foreground = labels.filter(label => label.index > 0);
  for (const label of foreground) {
    const idx = foreground.length === 1
      ? 255
      : Math.round((label.index / Math.max(...foreground.map(item => item.index))) * 255);
    const color = label.color || label.rgba || [128, 128, 128, 255];
    R[idx] = color[0];
    G[idx] = color[1];
    B[idx] = color[2];
    A[idx] = color[3];
  }

  return { R, G, B, A, min: 0, max: Math.max(1, ...foreground.map(label => label.index)) };
}

/**
 * Get label name by index.
 */
export function getLabelName(index, taskId = 'spinalcord') {
  const labels = getTaskLabels(taskId);
  return labels.find(label => label.index === index)?.name || `Label ${index}`;
}

/**
 * Get label color as [R, G, B, A] (0-255).
 */
export function getLabelColor(index, taskId = 'spinalcord') {
  const label = getTaskLabels(taskId).find(item => item.index === index);
  return label?.color || label?.rgba || [128, 128, 128, 255];
}
