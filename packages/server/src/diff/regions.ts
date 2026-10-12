import type { DiffRegion } from '@pagefreeze/shared';
export interface RegionOptions {
  padding?: number;
  minArea?: number;
  maxRegions?: number;
}
export interface ClusterResult {
  regions: DiffRegion[];
  totalChanged: number;
}

export function clusterRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  options: RegionOptions = {},
): ClusterResult {
  const padding = Math.max(0, options.padding ?? 12);
  const minArea = Math.max(1, options.minArea ?? 24);
  const maxRegions = Math.max(1, options.maxRegions ?? 50);

  let totalChanged = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) totalChanged += 1;
  }
  if (totalChanged === 0) return { regions: [], totalChanged: 0 };

  const cellSize = Math.max(1, padding);
  const gridWidth = Math.max(1, Math.ceil(width / cellSize));
  const gridHeight = Math.max(1, Math.ceil(height / cellSize));

  const filled = new Uint8Array(gridWidth * gridHeight);
  const counts = new Int32Array(gridWidth * gridHeight);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    const gy = (y / cellSize) | 0;
    for (let x = 0; x < width; x += 1) {
      if (!mask[rowOffset + x]) continue;
      const gx = (x / cellSize) | 0;
      const index = gy * gridWidth + gx;
      filled[index] = 1;
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }

  const labels = new Int32Array(gridWidth * gridHeight).fill(0);
  const stack: number[] = [];
  const components: Array<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    pixels: number;
  }> = [];

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const seed = gy * gridWidth + gx;
      if (!filled[seed] || labels[seed] !== 0) continue;

      const label = components.length + 1;
      stack.length = 0;
      stack.push(seed);
      labels[seed] = label;

      let minX = gx;
      let maxX = gx;
      let minY = gy;
      let maxY = gy;
      let pixels = 0;

      while (stack.length > 0) {
        const index = stack.pop()!;
        const cx = index % gridWidth;
        const cy = (index / gridWidth) | 0;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (filled[index]) pixels += counts[index] ?? 0;

        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = cy + dy;
          if (ny < 0 || ny >= gridHeight) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx;
            if (nx < 0 || nx >= gridWidth) continue;
            const nIndex = ny * gridWidth + nx;
            if (labels[nIndex] !== 0) continue;
            if (!filled[nIndex]) {
              labels[nIndex] = label;
              if (nx < minX) minX = nx;
              if (nx > maxX) maxX = nx;
              if (ny < minY) minY = ny;
              if (ny > maxY) maxY = ny;
              continue;
            }
            labels[nIndex] = label;
            stack.push(nIndex);
          }
        }
      }

      components.push({ minX, minY, maxX, maxY, pixels });
    }
  }

  const regions: DiffRegion[] = [];
  for (const component of components) {
    if (component.pixels < minArea) continue;

    const x = Math.max(0, component.minX * cellSize);
    const y = Math.max(0, component.minY * cellSize);
    const right = Math.min(width, (component.maxX + 1) * cellSize);
    const bottom = Math.min(height, (component.maxY + 1) * cellSize);

    regions.push({
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
      weight: component.pixels / totalChanged,
    });
  }

  regions.sort((a, b) => b.weight - a.weight);
  const trimmed = regions.slice(0, maxRegions);

  return { regions: trimmed, totalChanged };
}

export function regionsToSvg(regions: DiffRegion[], width: number, height: number): string {
  const body = regions
    .map(
      (r) =>
        `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="red" />`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`;
}
