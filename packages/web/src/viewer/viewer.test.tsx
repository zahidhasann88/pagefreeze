import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VisualDiff, VISUAL_MODES } from '../viewer/VisualDiff.js';
import { TextDiff } from '../viewer/TextDiff.js';
import { HtmlDiff } from '../viewer/HtmlDiff.js';
import type { HtmlDiff as HtmlDiffPayload, TextDiff as TextDiffPayload } from '../api/types.js';

/**
 * Change viewer component tests.
 *
 * Screenshots are never fetched from a server here: `Image` is stubbed so the component
 * believes a 200x100 image loaded, which is enough to drive the layout math, the mode
 * switching and the keyboard interactions that these tests are about.
 */

const WIDTH = 200;
const HEIGHT = 100;

beforeEach(() => {
  // jsdom's Image never loads; resolve it synchronously with a known natural size so the
  // viewer can position overlays.
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = WIDTH;
      naturalHeight = HEIGHT;
      #src = '';
      get src(): string {
        return this.#src;
      }
      set src(value: string) {
        this.#src = value;
        queueMicrotask(() => this.onload?.());
      }
    },
  );

  // getBoundingClientRect is 0x0 in jsdom; the fit-to-width calculation needs a real width.
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 800;
    },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: WIDTH,
      height: HEIGHT,
      top: 0,
      left: 0,
      right: WIDTH,
      bottom: HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

import type { DiffRegion } from '@pagefreeze/shared';

interface ViewerProps {
  beforeUrl: string | null;
  afterUrl: string;
  diffUrl: string | null;
  regions: DiffRegion[];
  pixelDiffPercent: number | null;
  sizeChanged: boolean;
  sizeFrom: { width: number; height: number } | null;
  sizeTo: { width: number; height: number } | null;
  beforeLabel: string;
  afterLabel: string;
}

const baseProps: ViewerProps = {
  beforeUrl: '/api/v1/snapshots/before/screenshot',
  afterUrl: '/api/v1/snapshots/after/screenshot',
  diffUrl: '/api/v1/changes/c1/diff-image',
  regions: [],
  pixelDiffPercent: 1.5,
  sizeChanged: false,
  sizeFrom: { width: WIDTH, height: HEIGHT },
  sizeTo: { width: WIDTH, height: HEIGHT },
  beforeLabel: 'Screenshot before the change',
  afterLabel: 'Screenshot after the change',
};

async function renderViewer(overrides: Partial<ViewerProps> = {}) {
  render(<VisualDiff {...baseProps} {...overrides} />);
  // The image "load" resolves in a microtask; wait for the toolbar to settle.
  await waitFor(() => expect(screen.queryByText('Loading screenshots…')).not.toBeInTheDocument());
}

describe('VisualDiff modes', () => {
  it('offers exactly the four documented modes', () => {
    expect(VISUAL_MODES.map((mode) => mode.value)).toEqual([
      'side-by-side',
      'slider',
      'onion',
      'diff',
    ]);
    for (const mode of VISUAL_MODES) {
      expect(mode.label).toBeTruthy();
      expect(mode.hint).toBeTruthy();
    }
  });

  it('starts in slider mode when a baseline exists', async () => {
    await renderViewer();
    expect(screen.getByRole('button', { name: /slider/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/reveal the newer capture/i)).toBeInTheDocument();
  });

  it('switches to side by side and shows both images with labels', async () => {
    await renderViewer();
    await userEvent.click(screen.getByRole('button', { name: /side by side/i }));

    expect(screen.getByRole('button', { name: /side by side/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByAltText('Screenshot before the change')).toBeInTheDocument();
    expect(screen.getByAltText('Screenshot after the change')).toBeInTheDocument();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
  });

  it('switches to onion skin and exposes a blend control', async () => {
    await renderViewer();
    await userEvent.click(screen.getByRole('button', { name: /onion skin/i }));

    const blend = screen.getByLabelText(/blend between before and after/i);
    expect(blend).toBeInTheDocument();
    expect(blend).toHaveValue('50');

    fireEvent.change(blend, { target: { value: '80' } });
    expect(blend).toHaveValue('80');
  });

  it('switches to the highlighted diff and shows the diff image', async () => {
    await renderViewer();
    await userEvent.click(screen.getByRole('button', { name: /highlighted diff/i }));

    const diffImage = screen.getByAltText(/highlighted pixel differences/i);
    expect(diffImage).toBeInTheDocument();
    expect(diffImage).toHaveAttribute('src', baseProps.diffUrl);
  });

  it('explains when there is no baseline to compare against', async () => {
    await renderViewer({ beforeUrl: null });

    // Slider is not a meaningful default with one image, so it starts on the diff.
    expect(screen.getByRole('button', { name: /highlighted diff/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Side by side is offered but disabled rather than silently broken.
    expect(screen.getByRole('button', { name: /side by side/i })).toBeDisabled();
  });

  it('shows a readable message when there is no diff image', async () => {
    await renderViewer({ diffUrl: null });
    await userEvent.click(screen.getByRole('button', { name: /highlighted diff/i }));

    expect(screen.getByText(/1.50% of pixels changed/)).toBeInTheDocument();
    expect(screen.getByText(/only stored when pixels actually differ/i)).toBeInTheDocument();
  });

  it('warns when the page size changed and explains the padding', async () => {
    await renderViewer({
      sizeChanged: true,
      sizeFrom: { width: 200, height: 100 },
      sizeTo: { width: 200, height: 300 },
    });
    expect(screen.getByText(/page size changed/i)).toBeInTheDocument();
    expect(screen.getByText(/200×100 → 200×300/)).toBeInTheDocument();
    expect(screen.getByText(/padded onto the larger canvas/i)).toBeInTheDocument();
  });

  it('reports a load failure instead of a blank canvas', async () => {
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 0;
        naturalHeight = 0;
        #src = '';
        get src(): string {
          return this.#src;
        }
        set src(value: string) {
          this.#src = value;
          queueMicrotask(() => this.onerror?.());
        }
      },
    );

    render(<VisualDiff {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByText(/screenshot could not be loaded/i)).toBeInTheDocument(),
    );
  });
});

describe('VisualDiff zoom and pan', () => {
  it('zooms in and out through the toolbar and reports the percentage', async () => {
    await renderViewer();

    const readout = () => screen.getByText(/^\d+%$/);
    const initial = Number.parseInt(readout().textContent ?? '0', 10);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(Number.parseInt(readout().textContent ?? '0', 10)).toBeGreaterThan(initial);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(Number.parseInt(readout().textContent ?? '0', 10)).toBeLessThan(initial);
  });

  it('clamps zoom to a usable range', async () => {
    await renderViewer();
    const readout = () => Number.parseInt(screen.getByText(/^\d+%$/).textContent ?? '0', 10);

    for (let index = 0; index < 40; index += 1) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      });
    }
    expect(readout()).toBeLessThanOrEqual(800);

    for (let index = 0; index < 60; index += 1) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
      });
    }
    expect(readout()).toBeGreaterThanOrEqual(10);
  });

  it('resets to actual size and fits to width', async () => {
    await renderViewer();
    const readout = () => Number.parseInt(screen.getByText(/^\d+%$/).textContent ?? '0', 10);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(readout()).not.toBe(100);

    await userEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(readout()).toBe(100);

    // The container is 800px wide and the image is 200px, so fit-to-width caps at 100%.
    await userEvent.click(screen.getByRole('button', { name: 'Fit to width' }));
    expect(readout()).toBeLessThanOrEqual(100);
  });

  it('zooms and pans from the keyboard, for anyone not using a mouse', async () => {
    await renderViewer({ diffUrl: null });
    await userEvent.click(screen.getByRole('button', { name: /highlighted diff/i }));

    const viewport = screen.getByRole('group', { name: /zoomable comparison/i });
    const readout = () => Number.parseInt(screen.getByText(/^\d+%$/).textContent ?? '0', 10);
    const before = readout();

    fireEvent.keyDown(viewport, { key: '+' });
    expect(readout()).toBeGreaterThan(before);

    fireEvent.keyDown(viewport, { key: '-' });
    fireEvent.keyDown(viewport, { key: '-' });
    expect(readout()).toBeLessThan(before);

    fireEvent.keyDown(viewport, { key: '+' });
    fireEvent.keyDown(viewport, { key: '0' });
    expect(readout()).toBe(100);

    // Arrow keys pan; the transform is what changes.
    const stage = viewport.firstElementChild as HTMLElement;
    const beforeTransform = stage.style.transform;
    fireEvent.keyDown(viewport, { key: 'ArrowRight' });
    expect(stage.style.transform).not.toBe(beforeTransform);
  });

  it('documents its own keyboard affordances', async () => {
    await renderViewer();
    const viewport = screen.getByRole('group', { name: /zoomable comparison/i });
    expect(viewport.getAttribute('aria-label')).toMatch(/arrow keys/i);
    expect(viewport).toHaveAttribute('tabindex', '0');
  });
});

describe('VisualDiff regions', () => {
  const regions = [
    { x: 10, y: 20, width: 40, height: 30, weight: 0.7 },
    { x: 120, y: 60, width: 20, height: 15, weight: 0.3 },
  ];

  it('draws a box per region in diff mode and lists them', async () => {
    await renderViewer({ regions });
    await userEvent.click(screen.getByRole('button', { name: /highlighted diff/i }));

    for (const [index, region] of regions.entries()) {
      const box = screen.getByRole('button', {
        name: new RegExp(`changed region ${index + 1} of ${regions.length}`, 'i'),
      });
      expect(box).toHaveStyle({ left: `${region.x}px`, top: `${region.y}px` });
    }

    expect(screen.getByText('Changed regions')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /show 2 regions/i })).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
  });

  it('can hide the region boxes without losing the list', async () => {
    await renderViewer({ regions });
    await userEvent.click(screen.getByRole('button', { name: /highlighted diff/i }));

    const toggle = screen.getByRole('checkbox', { name: /show 2 regions/i });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    expect(
      screen.queryByRole('button', { name: /changed region 1 of 2/i }),
    ).not.toBeInTheDocument();
    // The table is still there, so the information is not lost.
    expect(screen.getByText('Changed regions')).toBeInTheDocument();
  });

  it('does not offer the toggle when there are no regions', async () => {
    await renderViewer({ regions: [] });
    expect(screen.queryByRole('checkbox', { name: /show .* regions/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Changed regions')).not.toBeInTheDocument();
  });
});

describe('VisualDiff slider', () => {
  it('exposes a range input that moves the wipe', async () => {
    await renderViewer();
    const slider = screen.getByLabelText(/reveal the newer capture/i);
    expect(slider).toHaveValue('50');

    fireEvent.change(slider, { target: { value: '25' } });
    expect(slider).toHaveValue('25');
    expect(slider).toHaveAttribute('aria-valuetext', '25% showing the newer capture');

    // The visible handle follows the same value.
    const handle = document.querySelector('.slider-handle') as HTMLElement;
    expect(handle.style.left).toContain('25%');
  });

  it('clips the after image to the selected position', async () => {
    await renderViewer();
    const slider = screen.getByLabelText(/reveal the newer capture/i);
    fireEvent.change(slider, { target: { value: '70' } });

    const afterPane = document.querySelector('.slider-wrap__after') as HTMLElement;
    expect(afterPane.style.clipPath).toBe('inset(0 0 0 70%)');
  });

  it('drags with a pointer', async () => {
    await renderViewer();
    const wrap = document.querySelector('.slider-wrap') as HTMLElement;

    fireEvent.pointerDown(wrap, { clientX: WIDTH * 0.25, button: 0 });
    fireEvent.pointerMove(wrap, { clientX: WIDTH * 0.75 });
    fireEvent.pointerUp(wrap, { clientX: WIDTH * 0.75 });

    expect(screen.getByLabelText(/reveal the newer capture/i)).toHaveValue('75');
  });
});

describe('TextDiff', () => {
  const diff: TextDiffPayload = {
    added: 2,
    removed: 1,
    identical: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [' one', '-two', '+TWO', '+three', ' four'],
      },
    ],
    unified: '--- before\n+++ after\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three\n four\n',
    truncated: false,
    wordChanges: [
      { value: 'The price is ' },
      { value: '$19', removed: true },
      { value: '$29', added: true },
    ],
    wordDiffSkipped: false,
  };

  it('explains when text detection is off', () => {
    render(<TextDiff diff={null} />);
    expect(screen.getByText(/text comparison is off/i)).toBeInTheDocument();
  });

  it('reports identical text without rendering an empty diff', () => {
    render(<TextDiff diff={{ ...diff, identical: true }} />);
    expect(screen.getByText(/no text changes/i)).toBeInTheDocument();
    expect(screen.getByText(/visual or structural only/i)).toBeInTheDocument();
  });

  it('renders word-level changes with ins and del semantics', () => {
    render(<TextDiff diff={diff} />);

    expect(screen.getByText('$19').tagName).toBe('DEL');
    expect(screen.getByText('$29').tagName).toBe('INS');
    expect(screen.getByText('The price is')).toBeInTheDocument();
    // Stats are announced, not just coloured.
    expect(screen.getByText(/\+2/)).toBeInTheDocument();
    expect(screen.getByText(/-1/)).toBeInTheDocument();
  });

  it('switches to the line-level unified patch', async () => {
    render(<TextDiff diff={diff} />);
    await userEvent.click(screen.getByRole('button', { name: /line level/i }));

    expect(screen.getByRole('button', { name: /line level/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Unified patch')).toBeInTheDocument();
    expect(screen.getByText(/@@ -1,3 \+1,4 @@/)).toBeInTheDocument();
    expect(screen.getByText(/TWO/)).toBeInTheDocument();
  });

  it('says when the diff was truncated for display', () => {
    render(<TextDiff diff={{ ...diff, truncated: true }} />);
    expect(screen.getByText(/truncated for display/i)).toBeInTheDocument();
  });

  it('collapses a long list of hunks behind a show-all control', async () => {
    const manyHunks = Array.from({ length: 50 }, (_unused, index) => ({
      oldStart: index * 10 + 1,
      oldLines: 3,
      newStart: index * 10 + 1,
      newLines: 3,
      lines: [' ctx', '-old', '+new'],
    }));
    render(<TextDiff diff={{ ...diff, hunks: manyHunks }} />);
    await userEvent.click(screen.getByRole('button', { name: /line level/i }));

    const showAll = screen.getByRole('button', { name: /show all 50 hunks/i });
    await userEvent.click(showAll);
    expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument();
  });
});

describe('HtmlDiff', () => {
  const diff: HtmlDiffPayload = {
    added: 1,
    removed: 1,
    identical: false,
    blocks: [
      {
        folded: false,
        lines: [
          { type: 'unchanged', text: '<div>', oldLine: 1, newLine: 1 },
          { type: 'remove', text: '<p>Old</p>', oldLine: 2, newLine: null },
          { type: 'add', text: '<p>New</p>', oldLine: null, newLine: 2 },
          { type: 'unchanged', text: '</div>', oldLine: 3, newLine: 3 },
        ],
      },
      {
        folded: true,
        lines: Array.from({ length: 40 }, (_unused, index) => ({
          type: 'unchanged' as const,
          text: `<li>item ${index}</li>`,
          oldLine: index + 10,
          newLine: index + 10,
        })),
      },
    ],
    oldLineCount: 43,
    newLineCount: 43,
    truncated: false,
  };

  it('explains when HTML detection is off', () => {
    render(<HtmlDiff diff={null} />);
    expect(screen.getByText(/html comparison is off/i)).toBeInTheDocument();
  });

  it('reports identical markup', () => {
    render(<HtmlDiff diff={{ ...diff, identical: true }} />);
    expect(screen.getByText(/no html changes/i)).toBeInTheDocument();
  });

  it('escapes page markup instead of rendering it', () => {
    const dangerous: HtmlDiffPayload = {
      ...diff,
      blocks: [
        {
          folded: false,
          lines: [
            {
              type: 'add',
              text: '<img src=x onerror="window.__pwned = true">',
              oldLine: null,
              newLine: 1,
            },
          ],
        },
      ],
    };

    const { container } = render(<HtmlDiff diff={dangerous} />);

    // The markup is present as text...
    expect(container.textContent).toContain('onerror=');
    // ...but no element was created from it.
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('shows line numbers and change markers', () => {
    const { container } = render(<HtmlDiff diff={diff} />);
    expect(container.querySelector('.diff__line--add')).not.toBeNull();
    expect(container.querySelector('.diff__line--remove')).not.toBeNull();
    expect(screen.getByText('added line 2: <p>New</p>')).toBeInTheDocument();
    expect(container.querySelector('.diff__line--add')).not.toBeNull();
  });

  it('provides a screen-reader description per line', () => {
    render(<HtmlDiff diff={diff} />);
    expect(screen.getByText(/added line 2: <p>New<\/p>/)).toBeInTheDocument();
    expect(screen.getByText(/removed line 2: <p>Old<\/p>/)).toBeInTheDocument();
  });

  it('folds unchanged runs and can expand them', async () => {
    render(<HtmlDiff diff={diff} />);
    expect(screen.getByText(/40 unchanged line/)).toBeInTheDocument();

    const expand = screen.getByRole('button', { name: /expand 1 unchanged block/i });
    await userEvent.click(expand);

    expect(screen.getByText('<li>item 0</li>')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collapse unchanged blocks/i })).toBeInTheDocument();
  });

  it('documents the normalisation rules that were applied', () => {
    render(<HtmlDiff diff={diff} />);
    expect(screen.getByText(/nonce/)).toBeInTheDocument();
    expect(screen.getByText(/Document order is preserved/i)).toBeInTheDocument();
  });

  it('says when the stored diff was truncated and points at the raw files', () => {
    render(<HtmlDiff diff={{ ...diff, truncated: true }} />);
    expect(screen.getByText(/download the raw files/i)).toBeInTheDocument();
  });
});
