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
  list(prefix: string): Promise<StorageObject[]>;
  sizeOf(prefix: string): Promise<number>;
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
