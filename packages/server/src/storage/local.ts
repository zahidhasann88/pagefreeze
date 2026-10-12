import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type ReadStream,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { StorageObject, StorageProvider } from './types.js';

/**
 * Local filesystem storage.
 *
 * Keys are joined onto a root directory and then re-checked to be inside it, so a key
 * containing `../` cannot escape the data directory.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
    mkdirSync(this.root, { recursive: true });
  }

  getRoot(): string {
    return this.root;
  }

  private safePath(key: string): string {
    const normalised = String(key ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (normalised.length === 0) {
      throw new Error('storage key must not be empty');
    }
    const target = resolve(join(this.root, normalised));
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || rel.split(sep)[0] === '..') {
      throw new Error(`storage key escapes the data directory: ${key}`);
    }
    return target;
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const path = this.safePath(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.safePath(key);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  /** Streaming read for screenshots, which can be several megabytes. */
  createReadStream(key: string): ReadStream | null {
    const path = this.safePath(key);
    if (!existsSync(path)) return null;
    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    const path = this.safePath(key);
    rmSync(path, { force: true });
    this.pruneEmptyDirs(dirname(path));
  }

  async exists(key: string): Promise<boolean> {
    try {
      return existsSync(this.safePath(key));
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<StorageObject[]> {
    const base = prefix && prefix.length > 0 ? this.safePath(prefix) : this.root;
    if (!existsSync(base)) return [];

    const results: StorageObject[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const stats = statSync(full);
          results.push({
            key: relative(this.root, full).split(sep).join('/'),
            size: stats.size,
            lastModified: stats.mtime,
          });
        }
      }
    };

    if (statSync(base).isFile()) {
      const stats = statSync(base);
      results.push({
        key: relative(this.root, base).split(sep).join('/'),
        size: stats.size,
        lastModified: stats.mtime,
      });
      return results;
    }

    walk(base);
    return results;
  }

  async sizeOf(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    return objects.reduce((total, object) => total + object.size, 0);
  }

  resolve(key: string): string {
    return this.safePath(key);
  }

  async close(): Promise<void> {
    // nothing to release
  }

  /** Remove directories that became empty after a delete, up to the root. */
  private pruneEmptyDirs(startDir: string): void {
    let current = startDir;
    while (current.startsWith(this.root) && current !== this.root) {
      try {
        const entries = readdirSync(current);
        if (entries.length > 0) return;
        rmSync(current, { recursive: true, force: true });
      } catch {
        return;
      }
      current = dirname(current);
    }
  }
}
