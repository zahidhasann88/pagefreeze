import { useState } from 'react';
import type { HtmlDiff as HtmlDiffPayload } from '../api/types.js';
import { Alert, EmptyState } from '../components/ui.js';

/**
 * HTML diff viewer.
 *
 * Rendered strictly as escaped text. Stored page HTML is third-party content and is never
 * injected into this app's DOM: doing so would let a monitored page script the Pagefreeze
 * origin. Every line goes through React's text escaping, and the raw file is available as a
 * `text/plain` download from the API.
 *
 * Unchanged runs are folded, showing three lines of context around each change, which is
 * what makes a diff of a large document readable.
 */

const FOLD_THRESHOLD = 7;

export function HtmlDiff({ diff }: { diff: HtmlDiffPayload | null }) {
  const [showAllFolds, setShowAllFolds] = useState(false);

  if (!diff) {
    return (
      <EmptyState
        title="HTML comparison is off for this monitor"
        body="Enable “Compare normalised HTML” in the monitor settings to record HTML diffs."
      />
    );
  }

  if (diff.identical) {
    return (
      <EmptyState
        title="No HTML changes"
        body="The normalised markup of the two captures is identical. Scripts, inline styles, nonces and data-* attributes are stripped before comparison, so framework churn does not show up here."
      />
    );
  }

  const foldedCount = diff.blocks.filter((block) => block.folded).length;

  return (
    <div className="stack">
      <Alert kind="info">
        Shown as escaped text, never rendered. Page markup is third-party content; the raw file is
        available from the snapshot’s <code>/html</code> endpoint as <code>text/plain</code>.
      </Alert>

      <div className="viewer-toolbar">
        <span className="small mono" aria-live="polite">
          <span style={{ color: 'var(--ok)' }}>+{diff.added}</span>{' '}
          <span style={{ color: 'var(--failing)' }}>-{diff.removed}</span> lines ·{' '}
          {diff.oldLineCount} → {diff.newLineCount} lines total
        </span>
        {diff.truncated ? (
          <span className="small" style={{ color: 'var(--changed)' }}>
            Truncated for display — download the raw files for the complete diff
          </span>
        ) : null}
        {foldedCount > 0 ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setShowAllFolds((current) => !current)}
            aria-pressed={showAllFolds}
          >
            {showAllFolds
              ? 'Collapse unchanged blocks'
              : `Expand ${foldedCount} unchanged block(s)`}
          </button>
        ) : null}
      </div>

      <div className="card">
        <div className="card__body card__body--flush">
          <div className="diff" role="group" aria-label="HTML line diff">
            {diff.blocks.map((block, blockIndex) => {
              if (block.folded && !showAllFolds) {
                return (
                  <div className="diff__fold" key={blockIndex}>
                    <span aria-hidden="true">⋯</span>
                    <span>{block.lines.length} unchanged line(s)</span>
                  </div>
                );
              }

              return block.lines.map((line, lineIndex) => {
                const key = `${blockIndex}-${lineIndex}`;
                const className =
                  line.type === 'unchanged'
                    ? 'diff__line'
                    : `diff__line diff__line--${line.type === 'add' ? 'add' : 'remove'}`;

                return (
                  <div className={className} key={key}>
                    <span className="diff__num" aria-hidden="true">
                      {line.oldLine ?? ''}
                    </span>
                    <span className="diff__num" aria-hidden="true">
                      {line.newLine ?? ''}
                    </span>
                    <span className="diff__text">
                      <span aria-hidden="true">
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                      </span>
                      {line.text}
                    </span>
                    <span className="sr-only">
                      {line.type === 'add'
                        ? `added line ${line.newLine}: ${line.text}`
                        : line.type === 'remove'
                          ? `removed line ${line.oldLine}: ${line.text}`
                          : `unchanged: ${line.text}`}
                    </span>
                  </div>
                );
              });
            })}
          </div>
        </div>
      </div>

      <p className="small faint">
        Normalisation applied before diffing: comments, doctype, <code>script</code>,{' '}
        <code>style</code>, <code>noscript</code> and <code>template</code> removed; head metadata
        removed; <code>nonce</code>, <code>style</code>, <code>srcset</code> and every{' '}
        <code>data-*</code> attribute dropped; remaining attributes sorted per element; whitespace
        collapsed. Document order is preserved.
      </p>
    </div>
  );
}

export { FOLD_THRESHOLD };
