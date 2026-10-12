import { createTwoFilesPatch, diffLines, diffWordsWithSpace, structuredPatch } from 'diff';
import type { Change } from 'diff';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** `-`/` `/`+` prefixed lines, exactly as jsdiff produces them. */
  lines: string[];
}

export interface LineDiffResult {
  added: number;
  removed: number;
  identical: boolean;
  hunks: DiffHunk[];
  unified: string;
  truncated: boolean;
}

export interface WordChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface TextDiffResult extends LineDiffResult {
  wordChanges: WordChange[];
  /** True when the inputs were too large for a word-level diff; line level still applies. */
  wordDiffSkipped: boolean;
}

/** Keeps the payloads the API returns bounded for very large pages. */
export const MAX_DIFF_LINES = 2_000;
export const MAX_DIFF_CHARS = 400_000;

/**
 * Input caps.
 *
 * jsdiff's line and word algorithms are quadratic in the worst case, so an unbounded input
 * is a denial of service against the diff worker: a single very large page change could
 * occupy it for minutes. Both caps are far above what any realistic web page produces
 * (400k characters is roughly 80k words of visible text), and hitting either sets
 * `truncated` so the UI says so instead of silently showing a partial result.
 */
export const MAX_DIFF_INPUT_CHARS = 400_000;
/** Word-level diffing is much more expensive; it gets a tighter budget. */
export const MAX_WORD_DIFF_CHARS = 100_000;

/**
 * Normalise visible text for comparison.
 *
 * - Windows and old-Mac line endings become `\n`
 * - non-breaking and zero-width spaces become ordinary spaces
 * - trailing whitespace is stripped from every line
 * - runs of three or more blank lines collapse to two
 *
 * Pure whitespace changes therefore disappear before the diff sees them.
 */
export function normalizeText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toHunks(before: string, after: string): { hunks: DiffHunk[]; truncated: boolean } {
  const patch = structuredPatch('before', 'after', before, after, '', '', {
    context: 3,
    ignoreWhitespace: true,
  });

  const hunks: DiffHunk[] = [];
  let lines = 0;
  let truncated = false;

  for (const hunk of patch.hunks) {
    const remaining = MAX_DIFF_LINES - lines;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const slice = hunk.lines.slice(0, remaining);
    if (slice.length < hunk.lines.length) truncated = true;
    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: slice,
    });
    lines += slice.length;
  }

  return { hunks, truncated };
}

function unifiedPatch(before: string, after: string): string {
  const patch = createTwoFilesPatch('before', 'after', before, after, '', '', { context: 3 });
  return patch.length > MAX_DIFF_CHARS
    ? `${patch.slice(0, MAX_DIFF_CHARS)}\n... (truncated)`
    : patch;
}

function countStats(before: string, after: string): { added: number; removed: number } {
  const changes: Change[] = diffLines(before, after, { ignoreWhitespace: true });
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.added) added += change.count ?? 0;
    else if (change.removed) removed += change.count ?? 0;
  }
  return { added, removed };
}

export const EMPTY_TEXT_DIFF: TextDiffResult = {
  added: 0,
  removed: 0,
  identical: true,
  hunks: [],
  unified: '',
  truncated: false,
  wordChanges: [],
  wordDiffSkipped: false,
};

export function textDiff(beforeText: string, afterText: string): TextDiffResult {
  const normalizedBefore = normalizeText(beforeText);
  const normalizedAfter = normalizeText(afterText);

  if (normalizedBefore === normalizedAfter) return EMPTY_TEXT_DIFF;

  const inputTruncated =
    normalizedBefore.length > MAX_DIFF_INPUT_CHARS || normalizedAfter.length > MAX_DIFF_INPUT_CHARS;

  const before = inputTruncated
    ? normalizedBefore.slice(0, MAX_DIFF_INPUT_CHARS)
    : normalizedBefore;
  const after = inputTruncated ? normalizedAfter.slice(0, MAX_DIFF_INPUT_CHARS) : normalizedAfter;

  const { added, removed } = countStats(before, after);
  const { hunks, truncated } = toHunks(before, after);

  // Word level is skipped for very large inputs: it is quadratic and the line-level hunks
  // already describe the change. The UI falls back to them.
  const wordDiffSkipped = before.length > MAX_WORD_DIFF_CHARS || after.length > MAX_WORD_DIFF_CHARS;

  const wordChanges: WordChange[] = wordDiffSkipped
    ? []
    : diffWordsWithSpace(before, after).map((change) => ({
        value: change.value,
        ...(change.added ? { added: true } : {}),
        ...(change.removed ? { removed: true } : {}),
      }));

  return {
    added,
    removed,
    identical: false,
    hunks,
    unified: unifiedPatch(before, after),
    truncated: truncated || inputTruncated,
    wordChanges,
    wordDiffSkipped,
  };
}
