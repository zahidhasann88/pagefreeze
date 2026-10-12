import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { DiffRegion, SizeInfo } from '@pagefreeze/shared';
import { clusterRegions, type RegionOptions } from './regions.js';

export interface VisualDiffOptions extends RegionOptions {
  /** Per-pixel colour distance below which two pixels count as identical (0-1). */
  threshold?: number;
  /** When false, anti-aliased pixels are not counted as changes. */
  includeAA?: boolean;
  /** Colour used to highlight changed pixels in the diff image. */
  diffColor?: [number, number, number];
  /** Produce a diff image at all (set false to save CPU/memory). */
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
  /** PNG buffer of the highlighted diff, or null when not produced. */
  diffImage: Buffer | null;
}

/**
 * Pad the smaller image onto a canvas the size of the larger one so screenshots with
 * different dimensions can still be compared. The padding is white, which matches the
 * default page background and keeps the diff readable.
 */
function padToSize(source: PNG, width: number, height: number): Buffer {
  if (source.width === width && source.height === height) return source.data;

  const canvas = new PNG({ width, height, fill: true });
  canvas.data.fill(0xff);
  PNG.bitblt(source, canvas, 0, 0, source.width, source.height, 0, 0);
  return canvas.data;
}

/**
 * Compare two PNG screenshots.
 *
 * Images of different sizes are compared on the larger canvas and `sizeChanged` is
 * reported so the UI can explain the difference instead of silently failing.
 */
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
    // pixelmatch writes the diff colour for changed pixels and a greyscale copy for
    // unchanged ones, so "not grey or not the same alpha" is a reliable changed test.
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
