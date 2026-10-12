import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Change, Monitor, Snapshot } from '@pagefreeze/shared';
import { MonitorDetailPage } from './MonitorDetailPage.js';

/**
 * Timeline consistency tests.
 *
 * A capture writes its snapshot row first and its change row a moment later, after the
 * diff has been computed, and the snapshots/changes queries poll on independent
 * intervals. These tests pin the behaviour that keeps the timeline honest across that
 * gap:
 *
 *  1. A snapshot whose changeId is set must never render as a "baseline" row while the
 *     changes query is still serving its pre-diff page.
 *  2. Polling must not settle until the change object itself has arrived — settling on
 *     the bare changeId froze the timeline on the stale changes page (the race behind a
 *     flaky end-to-end run).
 */

interface Page<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

const MONITOR_ID = 'm1';
const SNAPSHOTS_PATH = `/monitors/${MONITOR_ID}/snapshots`;
const CHANGES_PATH = `/monitors/${MONITOR_ID}/changes`;

const mockState = vi.hoisted(() => ({
  responses: new Map<string, unknown>(),
  counts: new Map<string, number>(),
}));

vi.mock('../api/client.js', () => {
  const bump = (key: string): void => {
    mockState.counts.set(key, (mockState.counts.get(key) ?? 0) + 1);
  };
  const respond = async (key: string): Promise<unknown> => {
    bump(key);
    return mockState.responses.get(key);
  };
  class ApiError extends Error {
    readonly code = 'mock';
    readonly status = 0;
  }
  return {
    API_PREFIX: '/api/v1',
    ApiError,
    readCsrfCookie: () => null,
    apiRequest: (path: string) => respond(path),
    api: {
      get: (path: string) => respond(path),
      post: (path: string) => respond(`POST ${path}`),
      patch: (path: string) => respond(path),
      delete: (path: string) => respond(path),
    },
    artifactUrl: (path: string) => path,
    urls: {},
  };
});

function page<T>(data: T[]): Page<T> {
  return { data, nextCursor: null, hasMore: false };
}

function makeMonitor(): Monitor {
  return {
    id: MONITOR_ID,
    name: 'Pricing page',
    url: 'http://127.0.0.1:8091/pricing',
    enabled: true,
    paused: false,
    scheduleKind: 'preset',
    scheduleValue: 'daily',
    scheduleCron: '0 0 * * *',
    scheduleDescription: 'At 00:00 UTC every day',
    nextRunAt: null,
    devicePreset: 'desktop',
    viewportWidth: 1280,
    viewportHeight: 800,
    fullPage: true,
    waitStrategy: 'load',
    waitSelector: null,
    extraDelayMs: 0,
    captureSelector: null,
    ignoreSelectors: [],
    userAgent: null,
    changeThreshold: 0.5,
    detectText: true,
    detectHtml: true,
    retentionDays: null,
    tags: [],
    secrets: { headerNames: [], cookieNames: [] },
    channelIds: [],
    consecutiveFailures: 0,
    failureNotified: false,
    status: 'ok',
    lastRunAt: null,
    lastSnapshotAt: null,
    lastChangeAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 's1',
    monitorId: MONITOR_ID,
    status: 'success',
    capturedAt: new Date().toISOString(),
    finalUrl: 'http://127.0.0.1:8091/pricing',
    httpStatus: 200,
    loadDurationMs: 42,
    title: 'Pricing',
    errorMessage: null,
    screenshotWidth: 1280,
    screenshotHeight: 800,
    screenshotHash: 'hash-1',
    htmlHash: 'hash-1',
    textHash: 'hash-1',
    duplicateOf: null,
    bytes: 2048,
    changeId: null,
    ...overrides,
  };
}

function makeChange(overrides: Partial<Change> = {}): Change {
  return {
    id: 'c1',
    monitorId: MONITOR_ID,
    fromSnapshotId: 's1',
    toSnapshotId: 's2',
    createdAt: new Date().toISOString(),
    pixelDiffPercent: 0.42,
    changedPixels: 4275,
    totalPixels: 1_024_000,
    sizeChanged: false,
    sizeFrom: null,
    sizeTo: null,
    textAdded: 1,
    textRemoved: 0,
    htmlAdded: 2,
    htmlRemoved: 1,
    significant: true,
    summary: 'price changed',
    regions: [],
    hasDiffImage: true,
    ...overrides,
  };
}

function setResponses(next: { snapshots?: Snapshot[]; changes?: Change[] }): void {
  if (next.snapshots) mockState.responses.set(SNAPSHOTS_PATH, page(next.snapshots));
  if (next.changes) mockState.responses.set(CHANGES_PATH, page(next.changes));
}

function snapshotCalls(): number {
  return mockState.counts.get(SNAPSHOTS_PATH) ?? 0;
}

/**
 * Flush pending promise work under fake timers without reaching the 2s poll tick.
 * Two rounds: the first resolves the monitor query and mounts the timeline, the second
 * resolves the timeline's own snapshots/changes fetches.
 */
async function flush(): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
  }
}

function renderPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/monitors/${MONITOR_ID}`]}>
        <Routes>
          <Route path="/monitors/:monitorId" element={<MonitorDetailPage />} />
          <Route path="*" element={<div>elsewhere</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.responses.clear();
  mockState.counts.clear();
  mockState.responses.set(`/monitors/${MONITOR_ID}`, makeMonitor());
  mockState.responses.set('/channels', { data: [] });
  mockState.responses.set(`POST /monitors/${MONITOR_ID}/capture`, { jobId: 'job-1', mode: 'all' });
  setResponses({ snapshots: [], changes: [] });
});

describe('monitor timeline consistency', () => {
  it('never labels a snapshot with a pending change as a baseline capture', async () => {
    // The snapshots query already sees the new row (changeId set); the changes query is
    // still serving its pre-diff page. This is the exact window the diff creates.
    setResponses({
      snapshots: [makeSnapshot({ id: 's2', changeId: 'c1' }), makeSnapshot({ id: 's1' })],
      changes: [],
    });

    renderPage();

    expect(await screen.findByText(/Change recorded — loading details/i)).toBeInTheDocument();
    // Only the true first capture (s1) may show the baseline label.
    expect(screen.getAllByText(/Baseline capture/)).toHaveLength(1);
  });

  it('renders the change link once the changes query catches up', async () => {
    setResponses({
      snapshots: [makeSnapshot({ id: 's2', changeId: 'c1' }), makeSnapshot({ id: 's1' })],
      changes: [makeChange()],
    });

    renderPage();

    const link = await screen.findByRole('link', { name: /significant change/i });
    expect(link).toHaveAttribute('href', `/monitors/${MONITOR_ID}/changes/c1`);
    expect(screen.queryByText(/Baseline capture — nothing/i)).toBeInTheDocument(); // s1 only
    expect(screen.getAllByText(/Baseline capture/)).toHaveLength(1);
  });

  it('keeps polling until the change object arrives, then settles', async () => {
    vi.useFakeTimers();
    try {
      const s1 = makeSnapshot({ id: 's1' });
      const s2 = makeSnapshot({ id: 's2', changeId: 'c1' });
      setResponses({ snapshots: [s1], changes: [] });

      await act(async () => {
        renderPage();
      });
      await flush();
      expect(screen.getByText(/Baseline capture/)).toBeInTheDocument();

      // The second capture lands while the changes query is still stale.
      setResponses({ snapshots: [s2, s1] });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /capture now/i }));
      });
      await flush();
      expect(screen.getByText(/Change recorded — loading details/i)).toBeInTheDocument();

      const beforePoll = snapshotCalls();

      // Settling on the bare changeId would stop polling here and freeze the timeline on
      // the stale changes page; polling must continue while the change is not loaded.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(snapshotCalls()).toBeGreaterThan(beforePoll);

      // When the changes query finally serves the change, the row becomes the link.
      setResponses({ changes: [makeChange()] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByRole('link', { name: /significant change/i })).toBeInTheDocument();

      // Both queries agree now, so polling settles and no further fetches happen.
      const settledCalls = snapshotCalls();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6300);
      });
      expect(snapshotCalls()).toBe(settledCalls);
    } finally {
      vi.useRealTimers();
    }
  });
});
