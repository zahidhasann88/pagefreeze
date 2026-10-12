import { describe, expect, it } from 'vitest';
import { normalizeText, textDiff, MAX_DIFF_LINES } from '../../src/diff/text.js';
import { htmlDiff } from '../../src/diff/html.js';
import { isVolatileAttribute, normalizeHtml } from '../../src/diff/normalize.js';
import { normalizeVisibleText } from '../../src/capture/extract.js';

describe('normalizeText', () => {
  it('normalises line endings', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('turns non-breaking and zero-width spaces into ordinary ones or nothing', () => {
    expect(normalizeText('a\u00a0b')).toBe('a b');
    expect(normalizeText('a\u200bb')).toBe('ab');
    expect(normalizeText('a\ufeffb')).toBe('ab');
  });

  it('strips trailing whitespace per line', () => {
    expect(normalizeText('a   \nb\t\nc')).toBe('a\nb\nc');
  });

  it('collapses runs of blank lines', () => {
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims the ends', () => {
    expect(normalizeText('\n\n  hello  \n\n')).toBe('hello');
  });

  it('is idempotent', () => {
    const once = normalizeText('a\r\n\u00a0b   \n\n\n\nc');
    expect(normalizeText(once)).toBe(once);
  });

  it('treats nullish input as empty', () => {
    expect(normalizeText(undefined as unknown as string)).toBe('');
  });
});

describe('normalizeVisibleText', () => {
  it('collapses runs of spaces and tabs like a browser would render them', () => {
    expect(normalizeVisibleText('a    b\t\tc')).toBe('a b c');
  });

  it('keeps single newlines so the diff stays line oriented', () => {
    expect(normalizeVisibleText('line one\nline two')).toBe('line one\nline two');
  });
});

describe('textDiff', () => {
  it('reports identical text as such', () => {
    const result = textDiff('hello world', 'hello world');
    expect(result.identical).toBe(true);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.wordChanges).toEqual([]);
  });

  it('ignores pure whitespace changes', () => {
    expect(textDiff('a  \nb', 'a\nb').identical).toBe(true);
    expect(textDiff('a\r\nb', 'a\nb').identical).toBe(true);
    expect(textDiff('a\u00a0b', 'a b').identical).toBe(true);
  });

  it('counts added and removed lines', () => {
    const result = textDiff('one\ntwo\nthree', 'one\nTWO\nthree\nfour');
    expect(result.identical).toBe(false);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(2);
  });

  it('produces word-level changes', () => {
    const result = textDiff('The price is $19 per month', 'The price is $29 per month');
    const changed = result.wordChanges.filter((change) => change.added || change.removed);
    expect(changed.length).toBeGreaterThan(0);
    // Only the digits differ. jsdiff tokenises on non-word characters, so "$19" reaches
    // the diff as the unchanged "$" plus the removed "19".
    expect(changed.some((change) => change.removed && change.value === '19')).toBe(true);
    expect(changed.some((change) => change.added && change.value === '29')).toBe(true);
    expect(result.wordDiffSkipped).toBe(false);
    expect(
      result.wordChanges
        .filter((change) => !change.added && !change.removed)
        .map((c) => c.value)
        .join(''),
    ).toContain('The price is');
  });

  it('produces a unified patch', () => {
    const result = textDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma');
    expect(result.unified).toContain('---');
    expect(result.unified).toContain('+++');
    expect(result.unified).toContain('-beta');
    expect(result.unified).toContain('+BETA');
  });

  it('produces hunks with line numbers', () => {
    const before = Array.from({ length: 40 }, (_unused, index) => `line ${index}`).join('\n');
    const after = before.replace('line 20', 'line twenty');
    const result = textDiff(before, after);

    expect(result.hunks.length).toBeGreaterThan(0);
    const hunk = result.hunks[0]!;
    expect(hunk.oldStart).toBeGreaterThan(0);
    expect(hunk.newStart).toBeGreaterThan(0);
    expect(hunk.lines.some((line) => line.startsWith('-'))).toBe(true);
    expect(hunk.lines.some((line) => line.startsWith('+'))).toBe(true);
  });

  it('truncates very large diffs instead of building an unbounded payload', () => {
    const before = Array.from({ length: 1200 }, (_unused, index) => `before ${index}`).join('\n');
    const after = Array.from({ length: 1200 }, (_unused, index) => `after ${index}`).join('\n');

    const result = textDiff(before, after);
    const totalLines = result.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    expect(totalLines).toBeLessThanOrEqual(MAX_DIFF_LINES);
    expect(result.truncated).toBe(true);

    expect(result.added).toBe(1200);
    expect(result.removed).toBe(1200);
    // The word-level pass is skipped for inputs this large: it is quadratic.
    expect(result.wordDiffSkipped).toBe(false);
  });

  it('skips the quadratic word-level pass for very large inputs', () => {
    const before = Array.from({ length: 12_000 }, (_unused, index) => `word ${index} here`).join(
      '\n',
    );
    const after = before.replace('word 6000 here', 'word 6000 changed');

    const result = textDiff(before, after);
    expect(result.wordDiffSkipped).toBe(true);
    expect(result.wordChanges).toEqual([]);

    expect(result.added).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);
  });

  it('handles one side being empty', () => {
    const result = textDiff('', 'something new');
    expect(result.identical).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
  });
});

describe('normalizeHtml', () => {
  it('drops scripts and their content', () => {
    const out = normalizeHtml('<html><body><script>var a = 1;</script><p>Text</p></body></html>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('var a');
    expect(out).toContain('<p>');
    expect(out).toContain('Text');
  });

  it('drops styles and their content by default', () => {
    const out = normalizeHtml('<style>.a{color:red}</style><p>Text</p>');
    expect(out).not.toContain('color:red');
    expect(out).toContain('Text');
  });

  it('keeps styles when asked to', () => {
    const out = normalizeHtml('<style>.a{color:red}</style><p>Text</p>', { keepStyles: true });
    expect(out).toContain('color:red');
  });

  it('drops comments and doctype', () => {
    const out = normalizeHtml('<!doctype html><!-- a comment --><p>x</p>');
    expect(out).not.toContain('doctype');
    expect(out).not.toContain('a comment');
  });

  it('drops head metadata but keeps the title', () => {
    const out = normalizeHtml(
      '<head><meta charset="utf-8"><link rel="stylesheet" href="a.css"><title>Page</title></head><body>b</body>',
    );
    expect(out).not.toContain('charset');
    expect(out).not.toContain('stylesheet');
    expect(out).toContain('<title>');
    expect(out).toContain('Page');
  });

  it('drops volatile attributes including every data-* attribute', () => {
    const out = normalizeHtml(
      '<div nonce="abc" style="color:red" data-reactid="1" id="keep">x</div>',
    );
    expect(out).not.toContain('nonce');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('data-reactid');
    expect(out).toContain('id="keep"');
  });

  it('keeps volatile attributes when asked to', () => {
    const out = normalizeHtml('<div data-x="1" style="color:red">x</div>', {
      keepVolatileAttributes: true,
    });
    expect(out).toContain('data-x="1"');
    expect(out).toContain('style="color:red"');
  });

  it('sorts attributes so framework reordering is not a change', () => {
    const a = normalizeHtml('<a href="/x" class="btn" id="b">go</a>');
    const b = normalizeHtml('<a id="b" class="btn" href="/x">go</a>');
    expect(a).toBe(b);
  });

  it('never reorders elements, because order is meaningful', () => {
    const a = normalizeHtml('<p>one</p><p>two</p>');
    const b = normalizeHtml('<p>two</p><p>one</p>');
    expect(a).not.toBe(b);
  });

  it('writes void elements without a self-closing slash', () => {
    const out = normalizeHtml('<br /><img src="a.png" /><hr/>');
    expect(out).toContain('<br>');
    expect(out).toContain('<hr>');
    expect(out).not.toContain('/>');
  });

  it('collapses whitespace in text nodes', () => {
    const out = normalizeHtml('<p>  a\n\n   b  </p>');
    expect(out).toContain('a b');
  });

  it('produces one element per line so line diffing is readable', () => {
    const out = normalizeHtml('<div><p>a</p><p>b</p></div>');
    expect(out.split('\n')).toEqual(['<div>', '<p>', 'a', '</p>', '<p>', 'b', '</p>', '</div>']);
  });

  it('returns empty for empty input', () => {
    expect(normalizeHtml('')).toBe('');
  });

  it('marks truncation when the input exceeds the cap', () => {
    const out = normalizeHtml('<p>x</p>'.repeat(100), { maxChars: 50 });
    expect(out).toContain('normalisation truncated');
  });

  it('is a pure function with no state between calls', () => {
    normalizeHtml('<script>ignored</script>');
    const out = normalizeHtml('<p>kept</p>');
    expect(out).toBe('<p>\nkept\n</p>');
  });

  it('handles malformed markup without throwing', () => {
    expect(() => normalizeHtml('<div><p>unclosed')).not.toThrow();
    expect(() => normalizeHtml('<<<>>>')).not.toThrow();
  });
});

describe('isVolatileAttribute', () => {
  it('flags data attributes and known framework internals', () => {
    expect(isVolatileAttribute('data-anything')).toBe(true);
    expect(isVolatileAttribute('nonce')).toBe(true);
    expect(isVolatileAttribute('style')).toBe(true);
    expect(isVolatileAttribute('srcset')).toBe(true);
  });

  it('leaves content-bearing attributes alone', () => {
    expect(isVolatileAttribute('href')).toBe(false);
    expect(isVolatileAttribute('class')).toBe(false);
    expect(isVolatileAttribute('id')).toBe(false);
    expect(isVolatileAttribute('alt')).toBe(false);
  });
});

describe('htmlDiff', () => {
  it('reports identical markup as such', () => {
    const html = '<html><body><p>Same</p></body></html>';
    const result = htmlDiff(html, html);
    expect(result.identical).toBe(true);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('does not report a change when only a script changed', () => {
    const before = '<html><body><script>var v = 1;</script><p>Text</p></body></html>';
    const after = '<html><body><script>var v = 2;</script><p>Text</p></body></html>';
    expect(htmlDiff(before, after).identical).toBe(true);
  });

  it('does not report a change when only a nonce changed', () => {
    const before = '<div nonce="aaa"><p>Text</p></div>';
    const after = '<div nonce="bbb"><p>Text</p></div>';
    expect(htmlDiff(before, after).identical).toBe(true);
  });

  it('reports a content change with line numbers', () => {
    const before = '<div><p>Old price $19</p></div>';
    const after = '<div><p>New price $29</p></div>';
    const result = htmlDiff(before, after);

    expect(result.identical).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);

    const changed = result.blocks
      .flatMap((block) => block.lines)
      .filter((line) => line.type !== 'unchanged');
    expect(changed.some((line) => line.text.includes('$19') && line.type === 'remove')).toBe(true);
    expect(changed.some((line) => line.text.includes('$29') && line.type === 'add')).toBe(true);
  });

  it('folds long runs of unchanged lines', () => {
    const filler = Array.from({ length: 60 }, (_unused, index) => `<li>item ${index}</li>`).join(
      '',
    );
    const before = `<ul>${filler}<li>changed</li>${filler}</ul>`;
    const after = `<ul>${filler}<li>CHANGED</li>${filler}</ul>`;

    const result = htmlDiff(before, after);
    const folded = result.blocks.filter((block) => block.folded);
    expect(folded.length).toBeGreaterThan(0);

    const unfolded = result.blocks.filter((block) => !block.folded).flatMap((block) => block.lines);
    expect(unfolded.some((line) => line.text.includes('CHANGED'))).toBe(true);
  });

  it('reports both line counts', () => {
    const result = htmlDiff('<p>a</p>', '<p>a</p><p>b</p>');
    expect(result.oldLineCount).toBe(3);
    expect(result.newLineCount).toBe(6);
  });

  it('bounds the payload for a complete page rewrite', () => {
    const before = Array.from({ length: 3000 }, (_unused, index) => `<p>before ${index}</p>`).join(
      '',
    );
    const after = Array.from({ length: 3000 }, (_unused, index) => `<p>after ${index}</p>`).join(
      '',
    );
    const result = htmlDiff(before, after);
    const total = result.blocks.reduce((sum, block) => sum + block.lines.length, 0);
    expect(total).toBeLessThanOrEqual(4200);
    expect(result.truncated).toBe(true);
  });

  it('escapes nothing: content is passed through as text for the UI to escape', () => {
    const result = htmlDiff(
      '<p>&lt;script&gt;</p>',
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    const added = result.blocks.flatMap((b) => b.lines).filter((l) => l.type === 'add');
    expect(added.some((line) => line.text.includes('alert(1)'))).toBe(true);
  });
});
