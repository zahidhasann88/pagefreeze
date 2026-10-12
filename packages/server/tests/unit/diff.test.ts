import { describe, expect, it } from 'vitest';
import { visualDiff } from '../../src/diff/visual.js';
import { clusterRegions } from '../../src/diff/regions.js';
import { isSignificant, summarizeChange } from '../../src/diff/types.js';
import { runDiffInProcess } from '../../src/diff/runDiff.js';
import {
  BLACK,
  GREEN,
  RED,
  WHITE,
  decodePng,
  pageWithAntiAliasNoise,
  pageWithAntiAliasNoiseShifted,
  pageWithBlock,
  pngDimensions,
  solidPng,
} from '../helpers/pngFixtures.js';

describe('visualDiff', () => {
  it('reports zero difference for identical images', () => {
    const image = solidPng(64, 48, WHITE);
    const result = visualDiff(image, image);

    expect(result.changedPixels).toBe(0);
    expect(result.diffPercent).toBe(0);
    expect(result.sizeChanged).toBe(false);
    expect(result.regions).toEqual([]);

    expect(result.diffImage).toBeNull();
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
  });

  it('reports a small localised change and one region', () => {
    const before = solidPng(100, 100, WHITE);
    const after = pageWithBlock(100, 100, { x: 10, y: 10, width: 20, height: 20, color: RED });

    const result = visualDiff(before, after, { padding: 4, minArea: 8 });

    expect(result.changedPixels).toBe(400);
    expect(result.totalPixels).toBe(10_000);
    expect(result.diffPercent).toBeCloseTo(4, 5);
    expect(result.sizeChanged).toBe(false);
    expect(result.regions).toHaveLength(1);

    const region = result.regions[0]!;

    expect(region.x).toBeLessThanOrEqual(10);
    expect(region.y).toBeLessThanOrEqual(10);
    expect(region.x + region.width).toBeGreaterThanOrEqual(30);
    expect(region.y + region.height).toBeGreaterThanOrEqual(30);
    expect(region.weight).toBeCloseTo(1, 5);
    expect(result.diffImage).not.toBeNull();
  });

  it('counts every pixel when the whole image changes', () => {
    const result = visualDiff(solidPng(20, 20, WHITE), solidPng(20, 20, BLACK));
    expect(result.changedPixels).toBe(400);
    expect(result.diffPercent).toBeCloseTo(100, 5);
  });

  it('pads the smaller image when dimensions differ and reports the size change', () => {
    const before = solidPng(80, 60, WHITE);
    const after = solidPng(80, 120, WHITE);

    const result = visualDiff(before, after);

    expect(result.sizeChanged).toBe(true);
    expect(result.sizeFrom).toEqual({ width: 80, height: 60 });
    expect(result.sizeTo).toEqual({ width: 80, height: 120 });
    expect(result.width).toBe(80);
    expect(result.height).toBe(120);

    expect(result.changedPixels).toBe(0);
  });

  it('reports pixels in the added area as changed when the page grows with content', () => {
    const before = solidPng(60, 40, WHITE);
    const after = pageWithBlock(60, 80, { x: 0, y: 40, width: 60, height: 40, color: GREEN });

    const result = visualDiff(before, after);

    expect(result.sizeChanged).toBe(true);
    expect(result.width).toBe(60);
    expect(result.height).toBe(80);

    expect(result.changedPixels).toBe(2400);
    expect(result.diffPercent).toBeCloseTo(50, 5);
  });

  it('handles the wider-image case too', () => {
    const before = solidPng(40, 40, WHITE);
    const after = solidPng(100, 40, RED);

    const result = visualDiff(before, after);
    expect(result.sizeChanged).toBe(true);
    expect(result.width).toBe(100);
    expect(result.height).toBe(40);
    expect(result.changedPixels).toBe(4000);
  });

  it('does not count anti-aliasing noise as a change', () => {
    const before = pageWithAntiAliasNoise(100, 60);
    const after = pageWithAntiAliasNoiseShifted(100, 60);

    const withAA = visualDiff(before, after, { includeAA: true, threshold: 0.1 });
    const withoutAA = visualDiff(before, after, { includeAA: false, threshold: 0.1 });

    expect(withAA.changedPixels).toBeGreaterThanOrEqual(withoutAA.changedPixels);
    expect(withoutAA.changedPixels).toBe(0);
  });

  it('honours the per-pixel threshold', () => {
    const before = solidPng(10, 10, { r: 200, g: 200, b: 200 });
    const after = solidPng(10, 10, { r: 205, g: 200, b: 200 });

    expect(visualDiff(before, after, { threshold: 0.01 }).changedPixels).toBe(100);
    expect(visualDiff(before, after, { threshold: 0.5 }).changedPixels).toBe(0);
  });

  it('produces a diff PNG of the same dimensions as the comparison canvas', () => {
    const before = solidPng(50, 30, WHITE);
    const after = solidPng(50, 30, RED);

    const result = visualDiff(before, after);
    expect(result.diffImage).not.toBeNull();

    const dimensions = pngDimensions(result.diffImage!);
    expect(dimensions).toEqual({ width: 50, height: 30 });
  });

  it('can skip building the diff image to save work', () => {
    const result = visualDiff(solidPng(20, 20, WHITE), solidPng(20, 20, RED), {
      produceDiffImage: false,
    });
    expect(result.changedPixels).toBeGreaterThan(0);
    expect(result.diffImage).toBeNull();
  });

  it('marks changed pixels with a colour that is not greyscale', () => {
    const result = visualDiff(solidPng(4, 4, WHITE), solidPng(4, 4, BLACK));
    const diff = decodePng(result.diffImage!);

    expect(diff.data[0]).not.toBe(diff.data[1]);
  });
});

describe('clusterRegions', () => {
  function maskFrom(
    width: number,
    height: number,
    rectangles: Array<{ x: number; y: number; w: number; h: number }>,
  ): Uint8Array {
    const mask = new Uint8Array(width * height);
    for (const rectangle of rectangles) {
      for (let y = rectangle.y; y < rectangle.y + rectangle.h; y += 1) {
        for (let x = rectangle.x; x < rectangle.x + rectangle.w; x += 1) {
          mask[y * width + x] = 1;
        }
      }
    }
    return mask;
  }

  it('returns nothing for an empty mask', () => {
    const result = clusterRegions(new Uint8Array(100), 10, 10);
    expect(result.regions).toEqual([]);
    expect(result.totalChanged).toBe(0);
  });

  it('merges two nearby clusters into one', () => {
    const mask = maskFrom(200, 200, [
      { x: 10, y: 10, w: 10, h: 10 },
      { x: 24, y: 10, w: 10, h: 10 },
    ]);
    const result = clusterRegions(mask, 200, 200, { padding: 16, minArea: 8 });
    expect(result.regions).toHaveLength(1);
    expect(result.totalChanged).toBe(200);
  });

  it('keeps two distant clusters separate', () => {
    const mask = maskFrom(400, 400, [
      { x: 10, y: 10, w: 20, h: 20 },
      { x: 300, y: 300, w: 20, h: 20 },
    ]);
    const result = clusterRegions(mask, 400, 400, { padding: 8, minArea: 8 });
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0]!.weight + result.regions[1]!.weight).toBeCloseTo(1, 5);
  });

  it('drops clusters below minArea', () => {
    const mask = maskFrom(200, 200, [
      { x: 10, y: 10, w: 2, h: 2 }, // 4 pixels, below the threshold
      { x: 100, y: 100, w: 20, h: 20 },
    ]);
    const result = clusterRegions(mask, 200, 200, { padding: 8, minArea: 50 });
    expect(result.regions).toHaveLength(1);
  });

  it('never returns a region outside the image bounds', () => {
    const mask = maskFrom(60, 40, [{ x: 55, y: 35, w: 20, h: 20 }]);
    const result = clusterRegions(mask, 60, 40, { padding: 16, minArea: 1 });
    for (const region of result.regions) {
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(60);
      expect(region.y + region.height).toBeLessThanOrEqual(40);
    }
  });

  it('orders regions by weight, largest first', () => {
    const mask = maskFrom(400, 400, [
      { x: 10, y: 10, w: 5, h: 5 },
      { x: 300, y: 300, w: 40, h: 40 },
    ]);
    const result = clusterRegions(mask, 400, 400, { padding: 8, minArea: 1 });
    expect(result.regions[0]!.weight).toBeGreaterThanOrEqual(result.regions[1]!.weight);
  });

  it('respects maxRegions', () => {
    const rectangles = Array.from({ length: 30 }, (_unused, index) => ({
      x: (index % 6) * 60,
      y: Math.floor(index / 6) * 60,
      w: 10,
      h: 10,
    }));
    const result = clusterRegions(maskFrom(400, 400, rectangles), 400, 400, {
      padding: 4,
      minArea: 1,
      maxRegions: 5,
    });
    expect(result.regions).toHaveLength(5);
  });

  it('handles a non-square cell size larger than the image', () => {
    const result = clusterRegions(maskFrom(10, 10, [{ x: 0, y: 0, w: 10, h: 10 }]), 10, 10, {
      padding: 64,
      minArea: 1,
    });
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });
});

describe('isSignificant', () => {
  const base = { pixelDiffPercent: 0, text: null, html: null };

  it('is significant when the pixel diff meets the threshold', () => {
    expect(isSignificant({ ...base, pixelDiffPercent: 0.5 }, 0.5, false, false)).toBe(true);
    expect(isSignificant({ ...base, pixelDiffPercent: 2 }, 0.5, false, false)).toBe(true);
  });

  it('is not significant when the pixel diff is below the threshold', () => {
    expect(isSignificant({ ...base, pixelDiffPercent: 0.49 }, 0.5, false, false)).toBe(false);
    expect(isSignificant({ ...base, pixelDiffPercent: 0 }, 0.5, false, false)).toBe(false);
  });

  it('treats a threshold of zero as "any pixel change is significant"', () => {
    expect(isSignificant({ ...base, pixelDiffPercent: 0.0001 }, 0, false, false)).toBe(true);
    expect(isSignificant({ ...base, pixelDiffPercent: 0 }, 0, false, false)).toBe(true);
  });

  it('is significant when text changed, even below the pixel threshold', () => {
    // A price changing from "9" to "19" moves very few pixels but matters a lot.
    const text = { identical: false, added: 1, removed: 1 };
    expect(
      isSignificant({ ...base, pixelDiffPercent: 0.01, text } as never, 0.5, true, false),
    ).toBe(true);
  });

  it('ignores text changes when text detection is off', () => {
    const text = { identical: false, added: 1, removed: 1 };
    expect(
      isSignificant({ ...base, pixelDiffPercent: 0.01, text } as never, 0.5, false, false),
    ).toBe(false);
  });

  it('is significant when HTML changed and HTML detection is on', () => {
    const html = { identical: false, added: 2, removed: 0 };
    expect(isSignificant({ ...base, pixelDiffPercent: 0, html } as never, 0.5, false, true)).toBe(
      true,
    );
    expect(isSignificant({ ...base, pixelDiffPercent: 0, html } as never, 0.5, false, false)).toBe(
      false,
    );
  });

  it('is not significant when nothing changed', () => {
    expect(
      isSignificant(
        {
          pixelDiffPercent: 0,
          text: { identical: true, added: 0, removed: 0 },
          html: { identical: true, added: 0, removed: 0 },
        } as never,
        0.5,
        true,
        true,
      ),
    ).toBe(false);
  });

  it('handles a null pixel diff (visual comparison disabled)', () => {
    expect(isSignificant({ ...base, pixelDiffPercent: null }, 0.5, false, false)).toBe(false);
  });
});

describe('summarizeChange', () => {
  it('describes a significant visual and text change', () => {
    const summary = summarizeChange(
      {
        pixelDiffPercent: 1.234,
        sizeChanged: false,
        text: { identical: false, added: 3, removed: 1 },
        html: { identical: false, added: 5, removed: 2 },
      } as never,
      { significant: true, sizeChanged: false },
    );
    expect(summary).toContain('Significant change');
    expect(summary).toContain('1.23% of pixels changed');
    expect(summary).toContain('text +3/-1');
    expect(summary).toContain('html +5/-2');
  });

  it('describes a size change', () => {
    const summary = summarizeChange(
      { pixelDiffPercent: 0, sizeChanged: true, text: null, html: null } as never,
      { significant: false, sizeChanged: true },
    );
    expect(summary).toContain('Minor change');
    expect(summary).toContain('page size changed');
  });

  it('says so when no pixels changed', () => {
    const summary = summarizeChange(
      { pixelDiffPercent: 0, sizeChanged: false, text: null, html: null } as never,
      { significant: false, sizeChanged: false },
    );
    expect(summary).toContain('no pixel changes');
  });
});

describe('runDiffInProcess', () => {
  it('computes visual, text and HTML diffs together', () => {
    const result = runDiffInProcess({
      beforeScreenshot: solidPng(40, 40, WHITE),
      afterScreenshot: solidPng(40, 40, RED),
      beforeText: 'Hello world\nSecond line',
      afterText: 'Hello world\nSecond line changed',
      beforeHtml: '<html><body><p>Hello</p></body></html>',
      afterHtml: '<html><body><p>Hello there</p></body></html>',
      options: {
        pixelThreshold: 0.1,
        includeAA: false,
        regionPadding: 8,
        regionMinArea: 4,
        computeText: true,
        computeHtml: true,
        computeVisual: true,
        produceDiffImage: true,
      },
    });

    expect(result.pixelDiffPercent).toBeCloseTo(100, 5);
    expect(result.text?.added).toBe(1);
    expect(result.text?.removed).toBe(1);
    expect(result.html?.added).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('skips the parts that are switched off', () => {
    const result = runDiffInProcess({
      beforeScreenshot: solidPng(10, 10, WHITE),
      afterScreenshot: solidPng(10, 10, RED),
      beforeText: 'a',
      afterText: 'b',
      beforeHtml: '<p>a</p>',
      afterHtml: '<p>b</p>',
      options: {
        pixelThreshold: 0.1,
        includeAA: false,
        regionPadding: 8,
        regionMinArea: 4,
        computeText: false,
        computeHtml: false,
        computeVisual: false,
        produceDiffImage: false,
      },
    });

    expect(result.pixelDiffPercent).toBeNull();
    expect(result.text).toBeNull();
    expect(result.html).toBeNull();
    expect(result.regions).toEqual([]);
  });

  it('tolerates missing artefacts', () => {
    const result = runDiffInProcess({
      beforeScreenshot: null,
      afterScreenshot: null,
      beforeText: null,
      afterText: null,
      beforeHtml: null,
      afterHtml: null,
      options: {
        pixelThreshold: 0.1,
        includeAA: false,
        regionPadding: 8,
        regionMinArea: 4,
        computeText: true,
        computeHtml: true,
        computeVisual: true,
        produceDiffImage: true,
      },
    });

    expect(result.pixelDiffPercent).toBeNull();
    expect(result.text).toBeNull();
    expect(result.html).toBeNull();
  });
});
