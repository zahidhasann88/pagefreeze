import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { DiffRegion } from '@pagefreeze/shared';
import { Alert, Spinner } from '../components/ui.js';
import { IconColumns, IconTarget, IconZoomIn, IconZoomOut } from '../components/Icons.js';

export type VisualMode = 'side-by-side' | 'slider' | 'onion' | 'diff';

export const VISUAL_MODES: Array<{ value: VisualMode; label: string; hint: string }> = [
  { value: 'side-by-side', label: 'Side by side', hint: 'Before and after next to each other' },
  { value: 'slider', label: 'Slider', hint: 'Drag to wipe between before and after' },
  { value: 'onion', label: 'Onion skin', hint: 'Blend the two captures by opacity' },
  { value: 'diff', label: 'Highlighted diff', hint: 'Changed pixels, with region boxes' },
];
export interface VisualDiffProps {
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

function capturePointer(element: Element | null, pointerId: number): void {
  try {
    if (element && typeof element.setPointerCapture === 'function') {
      element.setPointerCapture(pointerId);
    }
  } catch {
    // not supported, or the pointer id is no longer valid
  }
}

function releasePointer(element: Element | null, pointerId: number): void {
  try {
    if (
      element &&
      typeof element.hasPointerCapture === 'function' &&
      element.hasPointerCapture(pointerId)
    ) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // nothing to release
  }
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const SCALE_STEP = 1.25;
interface Viewport {
  scale: number;
  x: number;
  y: number;
}

function ZoomPanViewport({
  children,
  scale,
  offset,
  onScaleChange,
  onOffsetChange,
  contentWidth,
  contentHeight,
  label,
}: {
  children: React.ReactNode;
  scale: number;
  offset: { x: number; y: number };
  onScaleChange: (scale: number, anchor?: { x: number; y: number }) => void;
  onOffsetChange: (offset: { x: number; y: number }) => void;
  contentWidth: number;
  contentHeight: number;
  label: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [panning, setPanning] = useState(false);
  const dragStart = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();

    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;

    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const direction = event.deltaY < 0 ? 1 : -1;
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, scale * (direction > 0 ? SCALE_STEP : 1 / SCALE_STEP)),
    );
    onScaleChange(next, anchor);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-no-pan]')) return;

    dragStart.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
    setPanning(true);
    capturePointer(ref.current, event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (!start) return;
    onOffsetChange({
      x: start.offsetX + (event.clientX - start.x),
      y: start.offsetY + (event.clientY - start.y),
    });
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return;
    dragStart.current = null;
    setPanning(false);
    releasePointer(ref.current, event.pointerId);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 120 : 40;
    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        onScaleChange(Math.min(MAX_SCALE, scale * SCALE_STEP));
        break;
      case '-':
      case '_':
        event.preventDefault();
        onScaleChange(Math.max(MIN_SCALE, scale / SCALE_STEP));
        break;
      case '0':
        event.preventDefault();
        onScaleChange(1);
        onOffsetChange({ x: 0, y: 0 });
        break;
      case 'ArrowLeft':
        event.preventDefault();
        onOffsetChange({ x: offset.x + step, y: offset.y });
        break;
      case 'ArrowRight':
        event.preventDefault();
        onOffsetChange({ x: offset.x - step, y: offset.y });
        break;
      case 'ArrowUp':
        event.preventDefault();
        onOffsetChange({ x: offset.x, y: offset.y + step });
        break;
      case 'ArrowDown':
        event.preventDefault();
        onOffsetChange({ x: offset.x, y: offset.y - step });
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={ref}
      className="canvas-viewport"
      data-panning={panning}
      tabIndex={0}
      role="group"
      aria-label={label}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onKeyDown={onKeyDown}
    >
      <div
        className="canvas-stage"
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
          width: contentWidth || undefined,
          height: contentHeight || undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function VisualDiff(props: VisualDiffProps) {
  const {
    beforeUrl,
    afterUrl,
    diffUrl,
    regions,
    pixelDiffPercent,
    sizeChanged,
    sizeFrom,
    sizeTo,
    beforeLabel,
    afterLabel,
  } = props;

  const [mode, setMode] = useState<VisualMode>(beforeUrl ? 'slider' : 'diff');
  const [viewport, setViewport] = useState<Viewport>({ scale: 1, x: 0, y: 0 });
  const [splitPosition, setSplitPosition] = useState(50);
  const [onionOpacity, setOnionOpacity] = useState(50);
  const [showRegions, setShowRegions] = useState(true);
  const [activeRegion, setActiveRegion] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    setLoading(true);
    setFailed(null);
    const image = new Image();
    image.onload = () => {
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
      setLoading(false);
    };
    image.onerror = () => {
      setFailed('The screenshot could not be loaded.');
      setLoading(false);
    };
    image.src = afterUrl;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [afterUrl]);

  const width = dimensions?.width ?? 0;
  const height = dimensions?.height ?? 0;

  useEffect(() => {
    if (!width || !containerRef.current) return;
    const available = containerRef.current.clientWidth - 4;
    if (available <= 0) return;
    const scale = Math.min(1, available / width);
    setViewport({ scale, x: 0, y: 0 });
  }, [width]);

  const setScale = useCallback((next: number, anchor?: { x: number; y: number }) => {
    setViewport((current) => {
      if (!anchor) return { ...current, scale: next };

      const ratio = next / current.scale;
      return {
        scale: next,
        x: anchor.x - (anchor.x - current.x) * ratio,
        y: anchor.y - (anchor.y - current.y) * ratio,
      };
    });
  }, []);

  const resetView = (): void => {
    setViewport({ scale: 1, x: 0, y: 0 });
  };

  const fitView = (): void => {
    if (!width || !containerRef.current) return;
    const available = containerRef.current.clientWidth - 4;
    setViewport({ scale: Math.min(1, available / Math.max(1, width)), x: 0, y: 0 });
  };

  if (failed) return <Alert kind="error">{failed}</Alert>;

  const modeIsStacked = mode !== 'side-by-side';

  return (
    <div className="stack" ref={containerRef}>
      <div className="viewer-toolbar">
        <div className="viewer-toolbar__group" role="group" aria-label="Visual comparison mode">
          {VISUAL_MODES.map((option) => {
            const disabled = option.value === 'side-by-side' && !beforeUrl;
            return (
              <button
                key={option.value}
                type="button"
                className="mode-btn"
                aria-pressed={mode === option.value}
                title={option.hint}
                disabled={disabled}
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="viewer-toolbar__group" role="group" aria-label="Zoom">
          <button
            type="button"
            className="mode-btn"
            onClick={() => setScale(Math.max(MIN_SCALE, viewport.scale / SCALE_STEP))}
            title="Zoom out (or press -)"
            aria-label="Zoom out"
          >
            <IconZoomOut size={14} />
          </button>
          <button
            type="button"
            className="mode-btn"
            onClick={() => setScale(Math.min(MAX_SCALE, viewport.scale * SCALE_STEP))}
            title="Zoom in (or press +)"
            aria-label="Zoom in"
          >
            <IconZoomIn size={14} />
          </button>
          <button
            type="button"
            className="mode-btn"
            onClick={fitView}
            title="Fit to width"
            aria-label="Fit to width"
          >
            Fit
          </button>
          <button
            type="button"
            className="mode-btn"
            onClick={resetView}
            title="Actual size (or press 0)"
            aria-label="Actual size"
          >
            1:1
          </button>
        </div>

        <span className="small mono faint nowrap" aria-live="polite">
          {Math.round(viewport.scale * 100)}%
        </span>

        {mode === 'diff' && regions.length > 0 ? (
          <label className="checkbox small">
            <input
              type="checkbox"
              checked={showRegions}
              onChange={(event) => setShowRegions(event.target.checked)}
            />
            Show {regions.length} region{regions.length === 1 ? '' : 's'}
          </label>
        ) : null}

        {mode === 'onion' ? (
          <label className="row small" style={{ gap: 6 }}>
            <span className="muted nowrap">Blend</span>
            <input
              className="range"
              type="range"
              min={0}
              max={100}
              step={1}
              value={onionOpacity}
              onChange={(event) => setOnionOpacity(Number.parseInt(event.target.value, 10))}
              aria-label="Blend between before and after"
            />
            <span className="mono faint nowrap">{onionOpacity}%</span>
          </label>
        ) : null}
      </div>

      {sizeChanged ? (
        <Alert kind="warn">
          The page size changed
          {sizeFrom && sizeTo
            ? `: ${sizeFrom.width}×${sizeFrom.height} → ${sizeTo.width}×${sizeTo.height}`
            : ''}
          . The smaller capture is padded onto the larger canvas so the two can still be compared,
          and the padding counts as a difference.
        </Alert>
      ) : null}

      {loading ? (
        <div className="state">
          <Spinner large label="Loading screenshots" />
          <div className="state__body">Loading screenshots…</div>
        </div>
      ) : null}

      {!loading && mode === 'side-by-side' ? (
        <SplitView
          beforeUrl={beforeUrl}
          afterUrl={afterUrl}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
          sizeFrom={sizeFrom}
          sizeTo={sizeTo}
        />
      ) : null}

      {!loading && modeIsStacked ? (
        <ZoomPanViewport
          scale={viewport.scale}
          offset={{ x: viewport.x, y: viewport.y }}
          onScaleChange={setScale}
          onOffsetChange={(offset) => setViewport((current) => ({ ...current, ...offset }))}
          contentWidth={width}
          contentHeight={height}
          label="Zoomable comparison. Drag to pan; hold ctrl and scroll to zoom; plus, minus, zero and the arrow keys also work."
        >
          {mode === 'slider' ? (
            <SliderView
              beforeUrl={beforeUrl}
              afterUrl={afterUrl}
              width={width}
              height={height}
              position={splitPosition}
              onPositionChange={setSplitPosition}
              beforeLabel={beforeLabel}
              afterLabel={afterLabel}
            />
          ) : null}

          {mode === 'onion' ? (
            <OnionView
              beforeUrl={beforeUrl}
              afterUrl={afterUrl}
              width={width}
              height={height}
              opacity={onionOpacity / 100}
              beforeLabel={beforeLabel}
              afterLabel={afterLabel}
            />
          ) : null}

          {mode === 'diff' ? (
            <DiffView
              diffUrl={diffUrl}
              afterUrl={afterUrl}
              width={width}
              height={height}
              regions={showRegions ? regions : []}
              activeRegion={activeRegion}
              onActiveRegion={setActiveRegion}
              pixelDiffPercent={pixelDiffPercent}
              afterLabel={afterLabel}
            />
          ) : null}
        </ZoomPanViewport>
      ) : null}

      {mode === 'diff' && regions.length > 0 ? (
        <RegionList
          regions={regions}
          activeRegion={activeRegion}
          onActiveRegion={setActiveRegion}
          totalChanged={pixelDiffPercent}
        />
      ) : null}
    </div>
  );
}

function SplitView({
  beforeUrl,
  afterUrl,
  beforeLabel,
  afterLabel,
  sizeFrom,
  sizeTo,
}: {
  beforeUrl: string | null;
  afterUrl: string;
  beforeLabel: string;
  afterLabel: string;
  sizeFrom: { width: number; height: number } | null;
  sizeTo: { width: number; height: number } | null;
}) {
  return (
    <div className="split">
      <div className="split__pane">
        <div className="split__label">
          <span>
            <IconColumns size={12} aria-hidden="true" /> Before
          </span>
          <span className="mono">{sizeFrom ? `${sizeFrom.width}×${sizeFrom.height}` : '—'}</span>
        </div>
        {beforeUrl ? (
          <img src={beforeUrl} alt={beforeLabel} loading="lazy" decoding="async" />
        ) : (
          <div className="state">
            <div className="state__body">
              No baseline capture. This was the first successful snapshot.
            </div>
          </div>
        )}
      </div>
      <div className="split__pane">
        <div className="split__label">
          <span>
            <IconColumns size={12} aria-hidden="true" /> After
          </span>
          <span className="mono">{sizeTo ? `${sizeTo.width}×${sizeTo.height}` : '—'}</span>
        </div>
        <img src={afterUrl} alt={afterLabel} loading="lazy" decoding="async" />
      </div>
    </div>
  );
}

function SliderView({
  beforeUrl,
  afterUrl,
  width,
  height,
  position,
  onPositionChange,
  beforeLabel,
  afterLabel,
}: {
  beforeUrl: string | null;
  afterUrl: string;
  width: number;
  height: number;
  position: number;
  onPositionChange: (value: number) => void;
  beforeLabel: string;
  afterLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const positionFromClientX = (clientX: number): number => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return position;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(100, Math.max(0, ratio * 100));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    onPositionChange(positionFromClientX(event.clientX));
    capturePointer(wrapRef.current, event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    onPositionChange(positionFromClientX(event.clientX));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = false;
    releasePointer(wrapRef.current, event.pointerId);
  };

  const clipAfter = `inset(0 0 0 ${position}%)`;

  return (
    <div style={{ width, height }}>
      <div
        ref={wrapRef}
        className="slider-wrap"
        style={{ width, height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {beforeUrl ? (
          <img
            src={beforeUrl}
            alt={beforeLabel}
            width={width}
            height={height}
            draggable={false}
            style={{ width, height }}
          />
        ) : (
          <div
            style={{
              width,
              height,
              background: 'var(--bg-sunken)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              lineHeight: 1.5,
            }}
          >
            No baseline capture
          </div>
        )}

        <div className="slider-wrap__after" style={{ clipPath: clipAfter }}>
          <img
            src={afterUrl}
            alt={afterLabel}
            width={width}
            height={height}
            draggable={false}
            style={{ width, height }}
          />
        </div>

        <div className="slider-handle" style={{ left: `calc(${position}% - 1.5px)` }} data-no-pan>
          <span className="slider-handle__grip" aria-hidden="true">
            ‖
          </span>
        </div>
      </div>

      <label className="sr-only" htmlFor="slider-position">
        Reveal the newer capture from left to right
      </label>
      <input
        id="slider-position"
        className="range"
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={position}
        onChange={(event) => onPositionChange(Number.parseFloat(event.target.value))}
        aria-valuetext={`${Math.round(position)}% showing the newer capture`}
        style={{ width: '100%', marginTop: 8 }}
      />
    </div>
  );
}

function OnionView({
  beforeUrl,
  afterUrl,
  width,
  height,
  opacity,
  beforeLabel,
  afterLabel,
}: {
  beforeUrl: string | null;
  afterUrl: string;
  width: number;
  height: number;
  opacity: number;
  beforeLabel: string;
  afterLabel: string;
}) {
  return (
    <div className="onion-wrap" style={{ width, height }}>
      {beforeUrl ? (
        <img
          src={beforeUrl}
          alt={beforeLabel}
          width={width}
          height={height}
          draggable={false}
          style={{ width, height }}
        />
      ) : (
        <div style={{ width, height, background: 'var(--bg-sunken)' }} aria-label={beforeLabel} />
      )}
      <div className="onion-wrap__top" style={{ opacity }} aria-hidden={!beforeUrl}>
        <img
          src={afterUrl}
          alt={beforeUrl ? '' : afterLabel}
          width={width}
          height={height}
          draggable={false}
          style={{ width, height }}
        />
      </div>
    </div>
  );
}

function DiffView({
  diffUrl,
  afterUrl,
  width,
  height,
  regions,
  activeRegion,
  onActiveRegion,
  pixelDiffPercent,
  afterLabel,
}: {
  diffUrl: string | null;
  afterUrl: string;
  width: number;
  height: number;
  regions: DiffRegion[];
  activeRegion: number | null;
  onActiveRegion: (index: number | null) => void;
  pixelDiffPercent: number | null;
  afterLabel: string;
}) {
  if (!diffUrl) {
    return (
      <div style={{ width, height, position: 'relative' }}>
        <img
          src={afterUrl}
          alt={afterLabel}
          width={width}
          height={height}
          draggable={false}
          style={{ width, height }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in srgb, var(--bg-sunken) 82%, transparent)',
            color: 'var(--text)',
            lineHeight: 1.5,
            padding: 20,
            textAlign: 'center',
          }}
        >
          <span>
            <strong>
              {pixelDiffPercent !== null && pixelDiffPercent > 0
                ? `${pixelDiffPercent.toFixed(2)}% of pixels changed`
                : 'No pixel differences'}
            </strong>
            <br />
            <span className="small muted">
              A highlighted diff image is only stored when pixels actually differ.
            </span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width, height, position: 'relative' }}>
      <img
        src={diffUrl}
        alt={`Highlighted pixel differences: ${pixelDiffPercent?.toFixed(2) ?? '0'}% of pixels changed`}
        width={width}
        height={height}
        draggable={false}
        style={{ width, height }}
      />
      {regions.length > 0 ? (
        <div className="region-overlay">
          {regions.map((region, index) => (
            <button
              key={`${region.x}-${region.y}-${index}`}
              type="button"
              className="region-box"
              data-no-pan
              style={{
                left: region.x,
                top: region.y,
                width: region.width,
                height: region.height,
                outline: activeRegion === index ? '3px solid var(--focus-ring)' : undefined,
              }}
              aria-label={`Changed region ${index + 1} of ${regions.length}: ${region.width} by ${region.height} pixels at ${region.x}, ${region.y}. ${Math.round(region.weight * 100)}% of all changed pixels.`}
              aria-pressed={activeRegion === index}
              onMouseEnter={() => onActiveRegion(index)}
              onMouseLeave={() => onActiveRegion(null)}
              onFocus={() => onActiveRegion(index)}
              onBlur={() => onActiveRegion(null)}
              onClick={() => onActiveRegion(activeRegion === index ? null : index)}
            >
              <span className="region-box__label">{index + 1}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RegionList({
  regions,
  activeRegion,
  onActiveRegion,
  totalChanged,
}: {
  regions: DiffRegion[];
  activeRegion: number | null;
  onActiveRegion: (index: number | null) => void;
  totalChanged: number | null;
}) {
  return (
    <div className="card">
      <div className="card__head">
        <h3>
          <IconTarget size={14} aria-hidden="true" /> Changed regions
        </h3>
        <span className="grow" />
        <span className="small mono muted">
          {regions.length} region{regions.length === 1 ? '' : 's'}
          {totalChanged !== null ? ` · ${totalChanged.toFixed(2)}% of pixels` : ''}
        </span>
      </div>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">
            Clusters of changed pixels, largest first. Focusing a row highlights it on the image.
          </caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Position</th>
              <th scope="col">Size</th>
              <th scope="col" className="num">
                Share of changes
              </th>
            </tr>
          </thead>
          <tbody>
            {regions.map((region, index) => (
              <tr
                key={`${region.x}-${region.y}-${index}`}
                onMouseEnter={() => onActiveRegion(index)}
                onMouseLeave={() => onActiveRegion(null)}
                style={activeRegion === index ? { background: 'var(--bg-hover)' } : undefined}
              >
                <td className="num">{index + 1}</td>
                <td className="mono">
                  {region.x}, {region.y}
                </td>
                <td className="mono">
                  {region.width} × {region.height}
                </td>
                <td className="num">{Math.round(region.weight * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
