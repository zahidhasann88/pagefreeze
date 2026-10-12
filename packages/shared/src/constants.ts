/**
 * Shared, dependency-free constants used by both the server and the web UI.
 */

export const VERSION = '0.1.0';

/**
 * Contact / crawl-identification part of the default User-Agent.
 * The server appends `Pagefreeze/<VERSION>` at runtime so the two never drift.
 */
export const USER_AGENT_PRODUCT = 'Pagefreeze';

export const USER_AGENT_URL = 'https://github.com/zahidhasann88/pagefreeze';

export const INTERVAL_PRESETS = {
  '15m': '*/15 * * * *',
  '1h': '0 * * * *',
  '6h': '0 */6 * * *',
  '24h': '0 0 * * *',
  '7d': '0 0 * * 0',
} as const;

export type IntervalPreset = keyof typeof INTERVAL_PRESETS;

export const INTERVAL_PRESET_KEYS = Object.keys(INTERVAL_PRESETS) as IntervalPreset[];

export const INTERVAL_PRESET_LABELS: Record<IntervalPreset, string> = {
  '15m': 'Every 15 minutes',
  '1h': 'Every hour',
  '6h': 'Every 6 hours',
  '24h': 'Every day',
  '7d': 'Every week',
};

export const DEVICE_PRESETS = {
  desktop: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: undefined as string | undefined,
  },
  tablet: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: undefined as string | undefined,
  },
  mobile: {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: undefined as string | undefined,
  },
} as const;

export type DevicePreset = keyof typeof DEVICE_PRESETS;
export const DEVICE_PRESET_KEYS = Object.keys(DEVICE_PRESETS) as DevicePreset[];

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export const WAIT_STRATEGIES = ['load', 'networkidle', 'selector'] as const;
export type WaitStrategy = (typeof WAIT_STRATEGIES)[number];

export const DEFAULT_CHANGE_THRESHOLD = 0.5;

export const MIN_CHANGE_THRESHOLD = 0;
export const MAX_CHANGE_THRESHOLD = 100;

export const MONITOR_STATUSES = ['ok', 'changed', 'failing', 'paused'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const CHANNEL_TYPES = ['webhook', 'slack', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const SNAPSHOT_STATUSES = ['success', 'failed'] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

/** Hard caps so a hostile or clumsy request cannot exhaust the box. */
export const LIMITS = {
  nameMax: 200,
  urlMax: 2048,
  tagMax: 40,
  tagsMax: 20,
  selectorMax: 500,
  ignoreSelectorsMax: 50,
  headersMax: 50,
  cookiesMax: 100,
  userAgentMax: 512,
  headerNameMax: 200,
  headerValueMax: 4096,
  cookieValueMax: 8192,
  bodyBytes: 256 * 1024,
  viewportMin: 200,
  viewportMax: 8000,
  delayMaxMs: 30_000,
  pageSizeMax: 200,
  pageSizeDefault: 20,
} as const;

export const HTTP_METHODS_ALLOWED = ['GET', 'HEAD'] as const;
