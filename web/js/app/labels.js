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
  const labels = [...getTaskLabels(taskId)].sort((a, b) => a.index - b.index);
  const R = [];
  const G = [];
  const B = [];
  const A = [];
  const I = [];
  const labelNames = [];

  for (const label of labels) {
    const color = label.color || label.rgba || [128, 128, 128, 255];
    R.push(color[0]);
    G.push(color[1]);
    B.push(color[2]);
    A.push(color[3]);
    I.push(label.index);
    labelNames.push(label.name);
  }

  return {
    R,
    G,
    B,
    A,
    I,
    labels: labelNames,
    min: 0,
    max: Math.max(1, ...labels.map(label => label.index))
  };
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
