import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { DiffRegion, SizeInfo } from '@pagefreeze/shared';
import { clusterRegions, type RegionOptions } from './regions.js';
export interface VisualDiffOptions extends RegionOptions {
  /** Per-pixel colour distance below which two pixels count as identical (0-1). */
  threshold?: number;
  includeAA?: boolean;
  diffColor?: [number, number, number];
  produceDiffImage?: boolean;
}
export interface VisualDiffResult {
  diffPercent: number;
  changedPixels: number;
  totalPixels: number;
  width: number;
  height: number;
  sizeChanged: boolean;
  sizeFrom: SizeInfo;
  sizeTo: SizeInfo;
  regions: DiffRegion[];
  diffImage: Buffer | null;
}

function padToSize(source: PNG, width: number, height: number): Buffer {
  if (source.width === width && source.height === height) return source.data;

  const canvas = new PNG({ width, height, fill: true });
  canvas.data.fill(0xff);
  PNG.bitblt(source, canvas, 0, 0, source.width, source.height, 0, 0);
  return canvas.data;
}

export function visualDiff(
  before: Buffer,
  after: Buffer,
  options: VisualDiffOptions = {},
): VisualDiffResult {
  const beforeImage = PNG.sync.read(before);
  const afterImage = PNG.sync.read(after);

  const width = Math.max(beforeImage.width, afterImage.width);
  const height = Math.max(beforeImage.height, afterImage.height);
  const sizeChanged =
    beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height;

  const beforeData = padToSize(beforeImage, width, height);
  const afterData = padToSize(afterImage, width, height);

  const totalPixels = width * height;
  const diff = new PNG({ width, height });

  const changedPixels = pixelmatch(beforeData, afterData, diff.data, width, height, {
    threshold: options.threshold ?? 0.1,
    includeAA: options.includeAA ?? false,
    ...(options.diffColor ? { diffColor: options.diffColor } : {}),
  });

  // Build a 1-byte-per-pixel mask for region clustering.
  const mask = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i += 1) {
    const offset = i * 4;
    const r = diff.data[offset] ?? 0;
    const g = diff.data[offset + 1] ?? 0;
    const b = diff.data[offset + 2] ?? 0;
    const a = diff.data[offset + 3] ?? 0;

    mask[i] = r !== g || g !== b || a !== 255 ? 1 : 0;
  }

  const { regions } = clusterRegions(mask, width, height, options);

  const produceDiffImage = options.produceDiffImage ?? true;

  return {
    diffPercent: totalPixels === 0 ? 0 : (changedPixels / totalPixels) * 100,
    changedPixels,
    totalPixels,
    width,
    height,
    sizeChanged,
    sizeFrom: { width: beforeImage.width, height: beforeImage.height },
    sizeTo: { width: afterImage.width, height: afterImage.height },
    regions,
    diffImage:
      produceDiffImage && changedPixels > 0 ? PNG.sync.write(diff, { colorType: 6 }) : null,
  };
}
