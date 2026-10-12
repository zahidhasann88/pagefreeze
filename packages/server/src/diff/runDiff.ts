import type { DiffRequest, DiffResult } from './types.js';
import { DEFAULT_DIFF_OPTIONS } from './types.js';
import { visualDiff } from './visual.js';
import { textDiff, type TextDiffResult } from './text.js';
import { htmlDiff, type HtmlDiffResult } from './html.js';

/**
 * Perform a full comparison. Pure and synchronous: safe to call from a worker thread.
 */
export function runDiffInProcess(request: DiffRequest): DiffResult {
  const started = Date.now();
  const options = { ...DEFAULT_DIFF_OPTIONS, ...request.options };

  let pixelDiffPercent: number | null = null;
  let changedPixels: number | null = null;
  let totalPixels: number | null = null;
  let sizeChanged = false;
  let sizeFrom: DiffResult['sizeFrom'] = null;
  let sizeTo: DiffResult['sizeTo'] = null;
  let regions: DiffResult['regions'] = [];
  let diffImage: Buffer | null = null;

  if (options.computeVisual && request.beforeScreenshot && request.afterScreenshot) {
    const visual = visualDiff(request.beforeScreenshot, request.afterScreenshot, {
      threshold: options.pixelThreshold,
      includeAA: options.includeAA,
      padding: options.regionPadding,
      minArea: options.regionMinArea,
      produceDiffImage: options.produceDiffImage,
    });
    pixelDiffPercent = visual.diffPercent;
    changedPixels = visual.changedPixels;
    totalPixels = visual.totalPixels;
    sizeChanged = visual.sizeChanged;
    sizeFrom = visual.sizeFrom;
    sizeTo = visual.sizeTo;
    regions = visual.regions;
    diffImage = visual.diffImage;
  }

  let text: TextDiffResult | null = null;
  if (options.computeText && request.beforeText !== null && request.afterText !== null) {
    text = textDiff(request.beforeText, request.afterText);
  }

  let html: HtmlDiffResult | null = null;
  if (options.computeHtml && request.beforeHtml !== null && request.afterHtml !== null) {
    html = htmlDiff(request.beforeHtml, request.afterHtml);
  }

  return {
    pixelDiffPercent,
    changedPixels,
    totalPixels,
    sizeChanged,
    sizeFrom,
    sizeTo,
    regions,
    diffImage,
    text,
    html,
    durationMs: Date.now() - started,
  };
}
