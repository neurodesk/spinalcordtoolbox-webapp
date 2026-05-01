import { getTaskLabels } from './sct-tasks.js';

export const LABELS = Object.freeze([
  { index: 0, name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255] },
]);

// NiiVue interpolates linearly between adjacent LUT stops. For discrete label
// maps this smears one vertebra into its neighbour at sub-voxel boundaries. We
// emit a step LUT: each label gets a stop at its integer index and another at
// just-below the next index, holding the color flat across (i, i+1).
const STEP_EPSILON = 1e-3;

export function generateNiivueColormap(taskId = 'spinalcord') {
  const labels = [...getTaskLabels(taskId)].sort((a, b) => a.index - b.index);
  const maxLabelIndex = Math.max(1, ...labels.map(label => label.index));
  const scaleToLutIndex = index => (index / maxLabelIndex) * 255;
  const R = [];
  const G = [];
  const B = [];
  const A = [];
  const I = [];
  const labelNames = [];

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const color = label.color || label.rgba || [128, 128, 128, 255];
    R.push(color[0]);
    G.push(color[1]);
    B.push(color[2]);
    A.push(color[3]);
    I.push(scaleToLutIndex(label.index));
    labelNames.push(label.name);

    const next = labels[i + 1];
    if (next && next.index > label.index + 1) continue;
    if (next) {
      R.push(color[0]);
      G.push(color[1]);
      B.push(color[2]);
      A.push(color[3]);
      I.push(scaleToLutIndex(next.index) - STEP_EPSILON);
      labelNames.push('');
    }
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
