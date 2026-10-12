/**
 * HTML normalisation for diffing.
 *
 * The rendered DOM differs from render to render for reasons that have nothing to do
 * with the page's content, and those differences would otherwise swamp the real ones.
 * The rules are deliberately conservative: attribute order aside, document order is
 * never changed, because order is meaningful, and text content is never touched.
 *
 * Rules applied (also documented in docs/architecture.md):
 *
 *   1. `<!doctype ...>` is dropped - it carries no content.
 *   2. HTML comments are dropped.
 *   3. `<script>`, `<style>`, `<noscript>` and `<template>` elements are dropped along
 *      with their content: they are code and generated CSS, not visible content.
 *   4. Metadata elements inside `<head>` are dropped (`meta`, `link`, `base`);
 *      `<title>` is kept.
 *   5. Volatile attributes are dropped: `nonce`, `style`, `srcset`, `sizes`,
 *      `integrity`, `crossorigin`, `tabindex`, every `data-*` attribute and a small
 *      list of framework-internal ones.
 *   6. The remaining attributes of each element are sorted alphabetically so that
 *      framework-driven reordering does not show up as a change.
 *   7. Void elements are written in the `<br>` form, never `<br />`.
 *   8. Runs of whitespace inside text collapse to a single space.
 *   9. Output is one tag (or one run of text) per line, so line-based diffing produces
 *      a readable result.
 *
 * The input is HTML produced by Playwright's `page.content()` on our own render, not
 * markup that will ever be executed: normalised HTML is stored and displayed as escaped
 * text only, never injected into the DOM.
 */

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Elements whose entire content is dropped. */
const DROP_CONTENT_ELEMENTS = new Set(['script', 'style', 'noscript', 'template']);

/** Elements dropped when they appear inside `<head>`. */
const HEAD_ONLY_DROPPED = new Set(['meta', 'link', 'base']);

/** Attributes that vary between renders without the page content changing. */
export const VOLATILE_ATTRIBUTES = new Set([
  'nonce',
  'style',
  'srcset',
  'sizes',
  'integrity',
  'crossorigin',
  'data-reactid',
  'data-reactroot',
  'tabindex',
]);

/** Any `data-*` attribute is treated as volatile. */
export function isVolatileAttribute(name: string): boolean {
  if (VOLATILE_ATTRIBUTES.has(name)) return true;
  if (name.startsWith('data-')) return true;
  return false;
}

export interface NormalizeHtmlOptions {
  /** Keep `<style>` blocks (default false: they are dropped with their content). */
  keepStyles?: boolean;
  /** Keep `data-*` and other volatile attributes (default false). */
  keepVolatileAttributes?: boolean;
  /** Maximum number of characters to normalise; the remainder is dropped with a marker. */
  maxChars?: number;
}

export const NORMALIZE_MAX_CHARS = 2_000_000;

/** Matches comments, doctypes and tags (open, close or self-closing). */
const TAG_RE = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-zA-Z][^>]*>/gi;

function parseAttributes(raw: string): Array<[string, string]> {
  const attributes: Array<[string, string]> = [];
  const attributeRe = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attributeRe.exec(raw)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes.push([name, value]);
  }
  return attributes;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise rendered HTML into a stable, line-oriented string suitable for diffing.
 * Pure function: no state is shared between calls.
 */
export function normalizeHtml(html: string, options: NormalizeHtmlOptions = {}): string {
  let source = String(html ?? '');
  if (source.length === 0) return '';

  const maxChars = options.maxChars ?? NORMALIZE_MAX_CHARS;
  let truncated = false;
  if (source.length > maxChars) {
    source = source.slice(0, maxChars);
    truncated = true;
  }

  const keepVolatile = options.keepVolatileAttributes ?? false;
  const keepStyles = options.keepStyles ?? false;

  const out: string[] = [];
  let cursor = 0;
  let inHead = false;
  // Element name whose content is currently being skipped, or null when nothing is.
  let dropping: string | null = null;

  const emitText = (from: number, to: number): void => {
    if (to <= from) return;
    if (dropping) return;
    const text = collapseWhitespace(source.slice(from, to));
    if (text) out.push(text);
  };

  source.replace(TAG_RE, (tag: string, offset: number) => {
    emitText(cursor, offset);
    cursor = offset + tag.length;

    // Inside a dropped element: only react to its own closing tag.
    if (dropping) {
      const innerClose = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
      if (innerClose && innerClose[1]!.toLowerCase() === dropping) dropping = null;
      return tag;
    }

    if (/^<!--/i.test(tag) || /^<!doctype/i.test(tag)) return tag;

    const closeMatch = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (closeMatch) {
      const name = closeMatch[1]!.toLowerCase();
      if (name === 'head') inHead = false;
      out.push(`</${name}>`);
      return tag;
    }

    const openMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (!openMatch) return tag;
    const name = openMatch[1]!.toLowerCase();
    const isVoid = VOID_ELEMENTS.has(name);
    const selfClosing = /\/>\s*$/.test(tag);

    if (name === 'head') {
      inHead = true;
      out.push('<head>');
      return tag;
    }

    if (!keepStyles && DROP_CONTENT_ELEMENTS.has(name)) {
      dropping = name;
      return tag;
    }

    if (inHead && HEAD_ONLY_DROPPED.has(name)) {
      if (!isVoid && !selfClosing) dropping = name;
      return tag;
    }

    const attributeSource = tag
      .slice(name.length + 1)
      .replace(/\/>\s*$/, '')
      .replace(/>\s*$/, '');

    const attributes = parseAttributes(attributeSource)
      .filter(([attributeName]) => keepVolatile || !isVolatileAttribute(attributeName))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([attributeName, value]) => `${attributeName}="${value}"`);

    // Void and self-closing elements are always written in the `<br>` form.
    const attributeText = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
    out.push(`<${name}${attributeText}>`);
    return tag;
  });

  emitText(cursor, source.length);

  if (truncated) out.push('<!-- normalisation truncated -->');

  return out.join('\n');
}
