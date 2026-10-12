import { diffLines } from 'diff';
import { normalizeHtml } from './normalize.js';

export const HTML_CONTEXT_LINES = 3;

export const MAX_HTML_DIFF_LINES = 4_000;

export const MAX_HTML_DIFF_INPUT_LINES = 6_000;

export type HtmlDiffLineType = 'add' | 'remove' | 'unchanged';
export interface HtmlDiffLine {
  type: HtmlDiffLineType;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface HtmlDiffBlock {
  folded: boolean;
  lines: HtmlDiffLine[];
}
export interface HtmlDiffResult {
  added: number;
  removed: number;
  identical: boolean;
  blocks: HtmlDiffBlock[];
  oldLineCount: number;
  newLineCount: number;
  truncated: boolean;
}

export const EMPTY_HTML_DIFF: HtmlDiffResult = {
  added: 0,
  removed: 0,
  identical: true,
  blocks: [],
  oldLineCount: 0,
  newLineCount: 0,
  truncated: false,
};

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n');
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function truncateLines(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_HTML_DIFF_INPUT_LINES) return text;
  return [...lines.slice(0, MAX_HTML_DIFF_INPUT_LINES), '<!-- diff input truncated -->'].join('\n');
}

export function htmlDiff(beforeHtml: string, afterHtml: string): HtmlDiffResult {
  const normalizedBefore = normalizeHtml(beforeHtml);
  const normalizedAfter = normalizeHtml(afterHtml);

  if (normalizedBefore === normalizedAfter) {
    return { ...EMPTY_HTML_DIFF, oldLineCount: splitLines(normalizedBefore).length };
  }

  const inputTruncated =
    countLines(normalizedBefore) > MAX_HTML_DIFF_INPUT_LINES ||
    countLines(normalizedAfter) > MAX_HTML_DIFF_INPUT_LINES;

  const before = inputTruncated ? truncateLines(normalizedBefore) : normalizedBefore;
  const after = inputTruncated ? truncateLines(normalizedAfter) : normalizedAfter;

  const changes = diffLines(before, after);
  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  const flat: HtmlDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let added = 0;
  let removed = 0;

  for (const change of changes) {
    const value = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value;
    for (const line of value.split('\n')) {
      if (flat.length >= MAX_HTML_DIFF_LINES && !change.added && !change.removed) {
        break;
      }
      if (change.added) {
        newIndex += 1;
        added += 1;
        flat.push({ type: 'add', text: line, oldLine: null, newLine: newIndex });
      } else if (change.removed) {
        oldIndex += 1;
        removed += 1;
        flat.push({ type: 'remove', text: line, oldLine: oldIndex, newLine: null });
      } else {
        oldIndex += 1;
        newIndex += 1;
        flat.push({ type: 'unchanged', text: line, oldLine: oldIndex, newLine: newIndex });
      }
      if (flat.length >= MAX_HTML_DIFF_LINES) break;
    }
    if (flat.length >= MAX_HTML_DIFF_LINES) break;
  }

  const truncated = flat.length >= MAX_HTML_DIFF_LINES || inputTruncated;

  // Fold runs of unchanged lines longer than 2 * context + 1.
  const blocks: HtmlDiffBlock[] = [];
  let current: HtmlDiffBlock = { folded: false, lines: [] };
  let unchangedRun: HtmlDiffLine[] = [];

  const flushUnchanged = (): void => {
    if (unchangedRun.length === 0) return;
    const maxInline = HTML_CONTEXT_LINES * 2 + 1;

    if (unchangedRun.length > maxInline) {
      const head = unchangedRun.slice(0, HTML_CONTEXT_LINES);
      const tail = unchangedRun.slice(-HTML_CONTEXT_LINES);
      const middle = unchangedRun.slice(
        HTML_CONTEXT_LINES,
        unchangedRun.length - HTML_CONTEXT_LINES,
      );

      if (head.length > 0) {
        current.lines.push(...head);
        blocks.push(current);
        current = { folded: false, lines: [] };
      }
      blocks.push({ folded: true, lines: middle });
      if (tail.length > 0) {
        current = { folded: false, lines: [...tail] };
      }
    } else {
      current.lines.push(...unchangedRun);
    }
    unchangedRun = [];
  };

  for (const line of flat) {
    if (line.type === 'unchanged') {
      unchangedRun.push(line);
      continue;
    }
    flushUnchanged();
    current.lines.push(line);
  }
  flushUnchanged();
  if (current.lines.length > 0) blocks.push(current);

  return {
    added,
    removed,
    identical: false,
    blocks,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    truncated,
  };
}
