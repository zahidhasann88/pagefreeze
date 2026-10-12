/**
 * A minimal YAML emitter.
 *
 * OpenAPI documents are nested maps, arrays and scalars, which is all this needs to
 * handle. Writing it here avoids adding a YAML dependency to the runtime for a build-time
 * script, and it produces stable, diff-friendly output (keys in insertion order, two-space
 * indent, double-quoted strings only where required).
 */

const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9_./-]*$/;

function needsQuotes(value: string): boolean {
  if (value.length === 0) return true;
  if (PLAIN_SAFE.test(value)) return false;
  return true;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const text = String(value);
  if (!needsQuotes(text)) return text;
  // JSON string escaping is a valid subset of YAML double-quoted style.
  return JSON.stringify(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    let out = '';
    for (const item of value) {
      if (isPlainObject(item) && Object.keys(item).length > 0) {
        const nested = toYamlObject(item, indent + 2);
        const lines = nested.split('\n').filter((line) => line.length > 0);
        const first = lines[0]?.slice(indent + 2) ?? '';
        out += `${pad}- ${first}\n`;
        for (const line of lines.slice(1)) out += `${line}\n`;
      } else if (Array.isArray(item)) {
        out += `${pad}-\n${toYaml(item, indent + 2)}`;
      } else {
        out += `${pad}- ${formatScalar(item)}\n`;
      }
    }
    return out;
  }

  if (isPlainObject(value)) return toYamlObject(value, indent);

  return `${pad}${formatScalar(value)}\n`;
}

function toYamlObject(value: Record<string, unknown>, indent: number): string {
  const pad = ' '.repeat(indent);
  const keys = Object.keys(value);
  if (keys.length === 0) return `${pad}{}\n`;

  let out = '';
  for (const key of keys) {
    const item = value[key];
    const safeKey = needsQuotes(key) ? JSON.stringify(key) : key;

    if (item === undefined) continue;

    if (Array.isArray(item)) {
      if (item.length === 0) {
        out += `${pad}${safeKey}: []\n`;
      } else {
        out += `${pad}${safeKey}:\n${toYaml(item, indent + 2)}`;
      }
    } else if (isPlainObject(item)) {
      if (Object.keys(item).length === 0) {
        out += `${pad}${safeKey}: {}\n`;
      } else {
        out += `${pad}${safeKey}:\n${toYamlObject(item, indent + 2)}`;
      }
    } else {
      out += `${pad}${safeKey}: ${formatScalar(item)}\n`;
    }
  }
  return out;
}
