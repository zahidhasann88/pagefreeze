/** Strip volatile markup before diffing. Keep document order because reordered content is a real change. */

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

const DROP_CONTENT_ELEMENTS = new Set(['script', 'style', 'noscript', 'template']);

const HEAD_ONLY_DROPPED = new Set(['meta', 'link', 'base']);

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

export function isVolatileAttribute(name: string): boolean {
  if (VOLATILE_ATTRIBUTES.has(name)) return true;
  if (name.startsWith('data-')) return true;
  return false;
}
export interface NormalizeHtmlOptions {
  keepStyles?: boolean;
  keepVolatileAttributes?: boolean;
  maxChars?: number;
}

export const NORMALIZE_MAX_CHARS = 2_000_000;

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

    const attributeText = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
    out.push(`<${name}${attributeText}>`);
    return tag;
  });

  emitText(cursor, source.length);

  if (truncated) out.push('<!-- normalisation truncated -->');

  return out.join('\n');
}
