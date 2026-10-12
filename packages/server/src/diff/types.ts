import type { DiffRegion, SizeInfo } from '@pagefreeze/shared';
import type { HtmlDiffResult } from './html.js';
import type { TextDiffResult } from './text.js';
export interface DiffRequest {
  beforeScreenshot: Buffer | null;
  afterScreenshot: Buffer | null;
  beforeText: string | null;
  afterText: string | null;
  beforeHtml: string | null;
  afterHtml: string | null;
  options: DiffEngineOptions;
}
export interface DiffEngineOptions {
  pixelThreshold: number;
  includeAA: boolean;
  regionPadding: number;
  regionMinArea: number;
  computeText: boolean;
  computeHtml: boolean;
  computeVisual: boolean;
  produceDiffImage: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffEngineOptions = {
  pixelThreshold: 0.1,
  includeAA: false,
  regionPadding: 12,
  regionMinArea: 24,
  computeText: true,
  computeHtml: true,
  computeVisual: true,
  produceDiffImage: true,
};
export interface DiffResult {
  pixelDiffPercent: number | null;
  changedPixels: number | null;
  totalPixels: number | null;
  sizeChanged: boolean;
  sizeFrom: SizeInfo | null;
  sizeTo: SizeInfo | null;
  regions: DiffRegion[];
  diffImage: Buffer | null;
  text: TextDiffResult | null;
  html: HtmlDiffResult | null;
  durationMs: number;
}

export function isSignificant(
  result: Pick<DiffResult, 'pixelDiffPercent' | 'text' | 'html'>,
  changeThresholdPercent: number,
  detectText: boolean,
  detectHtml: boolean,
): boolean {
  const pixelDiff = result.pixelDiffPercent ?? 0;
  if (pixelDiff >= changeThresholdPercent) return true;

  if (detectText && result.text && !result.text.identical) return true;
  if (detectHtml && result.html && !result.html.identical) return true;

  return false;
}
export interface ChangeSummaryOptions {
  significant: boolean;
  sizeChanged: boolean;
}

export function summarizeChange(
  result: Pick<DiffResult, 'pixelDiffPercent' | 'text' | 'html' | 'sizeChanged'>,
  options: ChangeSummaryOptions,
): string {
  const parts: string[] = [];

  if (result.pixelDiffPercent !== null && result.pixelDiffPercent > 0) {
    parts.push(`${result.pixelDiffPercent.toFixed(2)}% of pixels changed`);
  } else {
    parts.push('no pixel changes');
  }

  if (result.text && !result.text.identical) {
    parts.push(`text +${result.text.added}/-${result.text.removed}`);
  }
  if (result.html && !result.html.identical) {
    parts.push(`html +${result.html.added}/-${result.html.removed}`);
  }
  if (options.sizeChanged || result.sizeChanged) {
    parts.push('page size changed');
  }

  const verdict = options.significant ? 'Significant change' : 'Minor change';
  return `${verdict}: ${parts.join(', ')}`;
}
