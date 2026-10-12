import { PNG } from 'pngjs';

/**
 * PNG fixtures are generated rather than committed as binaries.
 *
 * A generated fixture is exact, reviewable in a diff, and cannot rot; a committed PNG is
 * none of those. Each helper documents the visual-diff case it exists to exercise.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };
export const RED: Rgb = { r: 220, g: 40, b: 40 };
export const GREEN: Rgb = { r: 40, g: 160, b: 70 };
export const BLUE: Rgb = { r: 40, g: 90, b: 200 };

/** A solid-colour PNG. */
export function solidPng(width: number, height: number, color: Rgb): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(png, x, y, color);
    }
  }
  return PNG.sync.write(png);
}

export function setPixel(png: PNG, x: number, y: number, color: Rgb, alpha = 255): void {
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color.r;
  png.data[offset + 1] = color.g;
  png.data[offset + 2] = color.b;
  png.data[offset + 3] = alpha;
}

/** A white page with a filled rectangle, standing in for a block of content. */
export function pageWithBlock(
  width: number,
  height: number,
  block: { x: number; y: number; width: number; height: number; color: Rgb },
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(png, x, y, WHITE);
  }
  for (let y = block.y; y < Math.min(height, block.y + block.height); y += 1) {
    for (let x = block.x; x < Math.min(width, block.x + block.width); x += 1) {
      setPixel(png, x, y, block.color);
    }
  }
  return PNG.sync.write(png);
}

/**
 * Anti-aliasing noise: a few pixels shifted by a small colour distance, the kind of thing
 * sub-pixel text rendering produces between two renders of the same page.
 *
 * With `includeAA: false` and a sane threshold these should not be reported as changes.
 */
export function pageWithAntiAliasNoise(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(png, x, y, WHITE);
  }
  // A soft gradient edge, as produced by text anti-aliasing.
  for (let y = 20; y < 24; y += 1) {
    for (let x = 20; x < 60; x += 1) {
      const shade = 250 - ((x + y) % 4);
      setPixel(png, x, y, { r: shade, g: shade, b: shade });
    }
  }
  return PNG.sync.write(png);
}

export function pageWithAntiAliasNoiseShifted(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(png, x, y, WHITE);
  }
  for (let y = 20; y < 24; y += 1) {
    for (let x = 20; x < 60; x += 1) {
      const shade = 250 - ((x + y + 1) % 4);
      setPixel(png, x, y, { r: shade, g: shade, b: shade });
    }
  }
  return PNG.sync.write(png);
}

/** Decode a PNG so a test can assert on raw pixels. */
export function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const png = decodePng(buffer);
  return { width: png.width, height: png.height };
}
