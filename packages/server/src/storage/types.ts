/**
 * StorageProvider is the seam between Pagefreeze and wherever snapshot artefacts live.
 *
 * Only the local filesystem implementation ships today; an S3-compatible provider is a
 * documented roadmap item (see README). Everything that touches artefacts goes through
 * this interface so the swap is contained.
 *
 * Keys are forward-slash separated relative paths, for example
 * `monitors/<monitorId>/snapshots/<snapshotId>/screenshot.png`. Providers own the
 * mapping from key to a physical location.
 */

export interface StorageObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface StorageProvider {
  readonly name: string;

  put(key: string, data: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;

  /** Every key under `prefix`, recursively. */
  list(prefix: string): Promise<StorageObject[]>;

  /** Total bytes stored under `prefix`. */
  sizeOf(prefix: string): Promise<number>;

  /** Absolute or URL form used to build a public/streaming reference, if any. */
  resolve(key: string): string;

  close(): Promise<void>;
}

export const SCREENSHOT_KEY = (monitorId: string, snapshotId: string): string =>
  `monitors/${monitorId}/snapshots/${snapshotId}/screenshot.png`;

export const HTML_KEY = (monitorId: string, snapshotId: string): string =>
  `monitors/${monitorId}/snapshots/${snapshotId}/page.html`;

export const TEXT_KEY = (monitorId: string, snapshotId: string): string =>
  `monitors/${monitorId}/snapshots/${snapshotId}/page.txt`;

export const DIFF_IMAGE_KEY = (monitorId: string, changeId: string): string =>
  `monitors/${monitorId}/changes/${changeId}/diff.png`;
