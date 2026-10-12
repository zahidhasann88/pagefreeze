import { useState } from 'react';
import type { TextDiff as TextDiffPayload, WordChange } from '../api/types.js';
import { EmptyState } from '../components/ui.js';

export function TextDiff({ diff }: { diff: TextDiffPayload | null }) {
  const [view, setView] = useState<'words' | 'lines'>('words');

  if (!diff) {
    return (
      <EmptyState
        title="Text comparison is off for this monitor"
        body="Enable “Compare visible text” in the monitor settings to record text diffs."
      />
    );
  }

  if (diff.identical) {
    return (
      <EmptyState
        title="No text changes"
        body="The visible text of the two captures is identical once whitespace is normalised. Any difference on this change is visual or structural only."
      />
    );
  }

  return (
    <div className="stack">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar__group" role="group" aria-label="Text diff view">
          <button
            type="button"
            className="mode-btn"
            aria-pressed={view === 'words'}
            onClick={() => setView('words')}
          >
            Word level
          </button>
          <button
            type="button"
            className="mode-btn"
            aria-pressed={view === 'lines'}
            onClick={() => setView('lines')}
          >
            Line level
          </button>
        </div>

        <span className="small mono" aria-live="polite">
          <span style={{ color: 'var(--ok)' }}>+{diff.added}</span>{' '}
          <span style={{ color: 'var(--failing)' }}>-{diff.removed}</span> lines
        </span>

        {diff.truncated ? (
          <span className="small" style={{ color: 'var(--changed)' }}>
            Truncated for display
          </span>
        ) : null}
      </div>

      {view === 'words' ? <WordView changes={diff.wordChanges} /> : <LineView diff={diff} />}
    </div>
  );
}

function WordView({ changes }: { changes: WordChange[] }) {
  if (changes.length === 0) {
    return <EmptyState title="Nothing to show" body="The word-level diff is empty." />;
  }

  return (
    <div className="card">
      <div className="card__body">
        <div className="word-diff">
          {changes.map((change, index) => {
            if (change.added) return <ins key={index}>{change.value}</ins>;
            if (change.removed) return <del key={index}>{change.value}</del>;
            return <span key={index}>{change.value}</span>;
          })}
        </div>
      </div>
    </div>
  );
}

function LineView({ diff }: { diff: TextDiffPayload }) {
  const [expanded, setExpanded] = useState(false);

  if (diff.hunks.length === 0) {
    return <EmptyState title="No hunks" body="The line-level diff produced no hunks." />;
  }

  const hunks = expanded ? diff.hunks : diff.hunks.slice(0, 40);

  return (
    <div className="card">
      <div className="card__head">
        <h3>Unified patch</h3>
        <span className="grow" />
        <span className="small faint mono">
          {diff.hunks.length} hunk{diff.hunks.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="card__body card__body--flush">
        <div className="diff">
          {hunks.map((hunk, index) => (
            <div key={index}>
              <div className="diff__fold mono">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              {hunk.lines.map((line, lineIndex) => {
                const marker = line.charAt(0);
                const text = line.slice(1);
                const kind = marker === '+' ? 'add' : marker === '-' ? 'remove' : 'unchanged';
                return (
                  <div
                    key={`${index}-${lineIndex}`}
                    className={
                      kind === 'unchanged' ? 'diff__line' : `diff__line diff__line--${kind}`
                    }
                  >
                    <span className="diff__num" aria-hidden="true" />
                    <span className="diff__num" aria-hidden="true" />
                    <span className="diff__text">
                      <span aria-hidden="true">{marker}</span>
                      {text}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {diff.hunks.length > 40 ? (
        <div className="pager">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Collapse' : `Show all ${diff.hunks.length} hunks`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
