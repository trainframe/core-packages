import type { Browser, Page } from '@playwright/test';
import { SIM_URL, VISUALISER_URL } from '../playwright.config.js';

/**
 * Drag a piece from the parts menu onto the toy-table canvas via the REAL
 * in-flight pointer gesture (feature B): press the tile, move onto the table —
 * which places the real piece and lets it follow the cursor — then release to
 * commit. Replaces the old native-HTML5-DnD helper; native DnD can't carry a
 * live, orientable piece (its drag image is a static snapshot). Drops at the
 * canvas centre, or `targetPosition` (px relative to the canvas) when given.
 * `orient` presses R (rotate) / F (flip) mid-drag, before release.
 */
export async function dragPieceFromToybox(
  page: Page,
  type: string,
  opts: { targetPosition?: { x: number; y: number }; orient?: Array<'r' | 'f'> } = {},
): Promise<void> {
  const tileBox = await page.getByTestId(`toybox-${type}`).boundingBox();
  const canvasBox = await page.getByTestId('toy-table-canvas').boundingBox();
  if (tileBox === null || canvasBox === null) {
    throw new Error('toybox tile or canvas not visible');
  }
  const sx = tileBox.x + tileBox.width / 2;
  const sy = tileBox.y + tileBox.height / 2;
  const tx = canvasBox.x + (opts.targetPosition?.x ?? canvasBox.width / 2);
  const ty = canvasBox.y + (opts.targetPosition?.y ?? canvasBox.height / 2);

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Move onto the table: the window pointermove listener places the real piece
  // and then follows the cursor.
  await page.mouse.move(tx, ty, { steps: 10 });
  // Rotate / flip the in-flight piece before dropping (the placed piece is
  // selected, so R/F act on it), then nudge so the preview refreshes.
  for (const k of opts.orient ?? []) {
    await page.keyboard.press(k);
  }
  if ((opts.orient ?? []).length > 0) await page.mouse.move(tx + 1, ty, { steps: 2 });
  await page.mouse.up();
}

/**
 * Shared Playwright helpers for opening the visualiser and simulator-ui
 * in fresh browser contexts. Each helper seeds localStorage with the
 * broker (and, for the visualiser, admin API) URL the test harness expects.
 *
 * Keep this file browser-side only — anything Node-shaped (http server,
 * aedes, etc.) belongs in `test-harness.ts`.
 */

/** MIME type for piece-to-scan-box DnD. Must match ScanBox.tsx. */
const SCANBOX_DATA_MIME = 'application/x-trainframe-piece';

export interface AssignScheduleOptions {
  /** Train ID to select in the ScheduleAssigner train picker. */
  readonly trainId: string;
  /** Ordered list of stop marker IDs to add before clicking Assign. */
  readonly stops: ReadonlyArray<string>;
}

/**
 * Drive the visualiser's `ScheduleAssigner` component (ADR-013 system-view
 * surface): pick the train, build the stops list, and click Assign.
 *
 * The ScheduleAssigner is only rendered once at least one train is
 * registered, so call this after the train has appeared in the visualiser.
 */
export async function assignSchedule(vis: Page, opts: AssignScheduleOptions): Promise<void> {
  const assigner = vis.getByTestId('schedule-assigner');
  await assigner.waitFor({ state: 'visible' });

  // Pick the train. The select's id is generated (useId), so target by
  // the accessible name "Train" which the <label> provides via htmlFor.
  await assigner.getByRole('combobox', { name: /\btrain\b/i }).selectOption(opts.trainId);

  // Add each stop in order. The label toggles between "First stop" (empty
  // list) and "Next stop" (list has items) — match both with /stop/i.
  for (const stop of opts.stops) {
    await assigner.getByRole('combobox', { name: /stop/i }).selectOption(stop);
    await assigner.getByRole('button', { name: /add stop/i }).click();
  }

  await assigner.getByRole('button', { name: /^assign$/i }).click();
}

export interface OpenVisualiserOptions {
  /** Override the broker WS URL the visualiser connects to. */
  readonly brokerUrl?: string;
  /** Set the admin API URL the visualiser uses for tag assignments. */
  readonly adminApiUrl?: string;
  /** When set, record a video of this page into the given directory. */
  readonly recordVideoDir?: string;
  /** Video resolution (defaults to 1280×900). */
  readonly recordVideoSize?: { readonly width: number; readonly height: number };
}

export async function openVisualiser(
  browser: Browser,
  opts: OpenVisualiserOptions = {},
): Promise<Page> {
  const brokerUrl = opts.brokerUrl ?? 'ws://127.0.0.1:9001';
  const ctx = await browser.newContext(
    opts.recordVideoDir !== undefined
      ? {
          recordVideo: {
            dir: opts.recordVideoDir,
            size: opts.recordVideoSize ?? { width: 1280, height: 900 },
          },
        }
      : {},
  );
  await ctx.addInitScript(
    ({ broker, admin }) => {
      localStorage.setItem('trainframe.visualiser.brokerUrl', broker);
      if (admin) localStorage.setItem('trainframe.visualiser.adminApiUrl', admin);
    },
    { broker: brokerUrl, admin: opts.adminApiUrl ?? null },
  );
  const page = await ctx.newPage();
  await page.goto(VISUALISER_URL);
  return page;
}

export interface OpenSimulatorUiOptions {
  /** Override the broker WS URL the sim UI connects to. */
  readonly brokerUrl?: string;
  /** When set, record a video of this page into the given directory. */
  readonly recordVideoDir?: string;
  /** Video resolution (defaults to 1280×800). Match the viewport you set. */
  readonly recordVideoSize?: { readonly width: number; readonly height: number };
}

export async function openSimulatorUi(
  browser: Browser,
  opts: OpenSimulatorUiOptions = {},
): Promise<Page> {
  const brokerUrl = opts.brokerUrl ?? 'ws://127.0.0.1:9001';
  const videoSize = opts.recordVideoSize ?? { width: 1280, height: 800 };
  const ctx = await browser.newContext(
    opts.recordVideoDir !== undefined
      ? { recordVideo: { dir: opts.recordVideoDir, size: videoSize } }
      : {},
  );
  await ctx.addInitScript(
    ({ broker }) => {
      localStorage.setItem('trainframe.simulator-ui.brokerUrl', broker);
    },
    { broker: brokerUrl },
  );
  const page = await ctx.newPage();
  await page.goto(SIM_URL);
  return page;
}

/**
 * Wait for the visualiser's connection-status output to flip to
 * `connected`. Mirrors the pattern in `tag-assignment.spec.ts` and gives
 * MQTT's subscribe ack a tick to land before the test publishes events
 * the UI must observe.
 */
export async function waitForVisualiserConnected(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const status = document.querySelector('output[data-status]');
    return status?.getAttribute('data-status') === 'connected';
  });
  // The MQTT subscribe ack happens after the `connected` status flip;
  // give it a tick to land before publishing events the UI must see.
  await page.waitForTimeout(300);
}

export interface PlacePieceOptions {
  /** Piece type to arm from the toybox and place. */
  readonly type: string;
  /**
   * Canvas position in mm (world-space). Defaults to the canvas centre
   * (450, 300) if omitted.
   */
  readonly xMm?: number;
  readonly yMm?: number;
  /**
   * For `type: 'carriage'`, the livery to pick before placing (a real operator
   * clicks the swatch row that appears when the carriage tool is armed). The
   * placed wagon carries this colour intrinsically.
   */
  readonly carriageColor?: 'red' | 'green' | 'amber' | 'blue' | 'purple';
  /**
   * For `type: 'straight'`, a LILLABO length variant (30/60/110/150) to pick
   * before placing — same arm → pick → re-arm flow a real operator uses. Omit
   * (or 200) for the default plank.
   */
  readonly straightLengthMm?: number;
  /** Number of 45° rotations (`R` key presses) to apply after placing. */
  readonly rotateSteps?: number;
  /** Whether to flip the piece (`F` key) after placing — left/right curves. */
  readonly flip?: boolean;
}

/**
 * Place a piece on the toy-table canvas.
 *
 * 1. If the toybox button for `type` is not already armed (aria-pressed ≠ "true"),
 *    click it to arm it.
 * 2. Click the canvas at the given position (mm coords mapped to px via the
 *    SVG's current bounding rect and the data-viewport-* attributes the canvas
 *    exposes).
 * 3. Return the `data-piece-id` of the newly placed piece (read from the DOM
 *    rather than predicted from a module-level counter, which is fragile).
 */
export async function placePieceOnToyTable(sim: Page, opts: PlacePieceOptions): Promise<string> {
  const { type, xMm = 450, yMm = 300, carriageColor, straightLengthMm } = opts;

  // Arm the toybox button if not already armed.
  const toyboxBtn = sim.getByTestId(`toybox-${type}`);
  const pressed = await toyboxBtn.getAttribute('aria-pressed');
  if (pressed !== 'true') {
    await toyboxBtn.click();
  }

  // Pick a straight length variant from the fan that opens when the straight
  // tool is armed, then re-arm to the chosen length (press → pick → press →
  // place — picking resets the arm). Mirrors the carriage-livery flow below.
  if (type === 'straight' && straightLengthMm !== undefined && straightLengthMm !== 200) {
    await sim.getByTestId(`toybox-straight-length-${straightLengthMm}`).click();
    await toyboxBtn.click();
    await sim.waitForFunction(
      (t: string) =>
        document.querySelector(`[data-testid="toybox-${t}"]`)?.getAttribute('aria-pressed') ===
        'true',
      type,
    );
  }

  // Wait for the arm to take effect: the button must report aria-pressed="true"
  // before we fire the canvas click, otherwise React may not have re-rendered
  // with the new armedType yet.
  await sim.waitForFunction((t: string) => {
    const btn = document.querySelector(`[data-testid="toybox-${t}"]`);
    return btn?.getAttribute('aria-pressed') === 'true';
  }, type);

  // Pick the carriage livery from the fan that opens when the carriage tool is
  // armed. Picking a variant reconfigures the family and RESETS the arm (a
  // configuration gesture, not a placement one), so re-arm to the chosen variant
  // before placing — exactly the operator flow (press → pick → press → place).
  if (type === 'carriage' && carriageColor !== undefined) {
    await sim.getByTestId(`toybox-carriage-color-${carriageColor}`).click();
    await toyboxBtn.click();
    await sim.waitForFunction((t: string) => {
      const btn = document.querySelector(`[data-testid="toybox-${t}"]`);
      return btn?.getAttribute('aria-pressed') === 'true';
    }, type);
  }

  // Capture the piece IDs that exist before the click, so we can diff. The
  // new piece must be found by SET difference, not document order: pieces
  // render bucketed by layer and track-before-device phases, so the newest
  // piece is NOT necessarily last in the DOM (a station placed after a
  // carriage paints before it).
  const idsBefore = new Set(
    await sim
      .locator('[data-piece-id]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-piece-id')).filter((id): id is string => id !== null),
      ),
  );

  // The canvas is an SVG with a viewBox driven by viewport state. We convert
  // world-space mm to element-relative px using the bounding rect and the
  // viewport attributes on the SVG element.
  const canvas = sim.getByTestId('toy-table-canvas');
  await canvas.waitFor({ state: 'visible' });

  const clickInfo = await canvas.evaluate(
    (el, { xMm, yMm }) => {
      const svg = el as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      const zoom = Number(svg.getAttribute('data-viewport-zoom') ?? '1');
      const vpX = Number(svg.getAttribute('data-viewport-x') ?? '0');
      const vpY = Number(svg.getAttribute('data-viewport-y') ?? '0');
      const canvasWMm = 900;
      const worldW = canvasWMm / zoom;
      // The canvas adapts its world HEIGHT to the box aspect (see ToyTable's
      // `clientToMm`): worldH = worldW * (rectHeight/rectWidth). Mirror that, or
      // off-centre Y placements land in the wrong spot.
      const worldH = worldW * (rect.height / rect.width);
      // Fraction of the world window where this mm coord falls.
      const fracX = (xMm - vpX) / worldW;
      const fracY = (yMm - vpY) / worldH;
      // Offset from the element's top-left corner.
      const offsetX = fracX * rect.width;
      const offsetY = fracY * rect.height;
      // Absolute client coordinates for page.mouse.click().
      return {
        clientX: rect.left + offsetX,
        clientY: rect.top + offsetY,
        // Clamp to visible viewport (window.innerWidth/innerHeight).
        clampedX: Math.min(rect.left + offsetX, window.innerWidth - 1),
        clampedY: Math.min(rect.top + offsetY, window.innerHeight - 1),
      };
    },
    { xMm, yMm },
  );

  await sim.mouse.click(clickInfo.clampedX, clickInfo.clampedY);

  // Wait for a new piece to appear.
  await sim.waitForFunction(
    (before: number) => document.querySelectorAll('[data-piece-id]').length > before,
    idsBefore.size,
  );

  // The newly placed piece is the one that wasn't there before the click.
  const allPieceIds = await sim
    .locator('[data-piece-id]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-piece-id')).filter((id): id is string => id !== null),
    );
  const pieceId = allPieceIds.find((id) => !idsBefore.has(id));
  if (pieceId === undefined) {
    throw new Error('placePieceOnToyTable: no piece appeared after click');
  }

  // A freshly-placed piece is selected, so the R/F keyboard shortcuts act on it
  // — exactly the gestures an operator uses to orient a curve before it snaps.
  if (opts.flip === true) {
    await sim.keyboard.press('f');
  }
  for (let i = 0; i < (opts.rotateSteps ?? 0); i++) {
    await sim.keyboard.press('r');
  }

  return pieceId;
}

/**
 * Scan a placed piece into the bus: dispatch the DnD drop onto the scan box
 * and then click the **Bind** button to confirm. This auto-confirm approach
 * keeps e2e tests focused on wire shape rather than the UI confirmation
 * gesture.
 *
 * Playwright's `dragTo()` fires mouse events, not HTML5 DragEvent with real
 * dataTransfer — so we dispatch the drop directly from `page.evaluate`. The
 * `bubbles: true` flag is required because React delegates listeners at the
 * root.
 *
 * Updated to include the Bind click after the ScanBox confirmation panel was
 * introduced (drop alone no longer fires bus events). See the unit-test
 * `dropPieceOnScanBox` helper for the parallel change in `ToyTable.test.tsx`.
 */
export async function scanPiece(sim: Page, pieceId: string): Promise<void> {
  await sim.evaluate(
    ({ id, mime }) => {
      const scanBox = document.querySelector('[data-testid="scan-box"]');
      if (scanBox === null) throw new Error('scan-box not found');
      const dt = new DataTransfer();
      dt.setData(mime, id);
      const dropEvent = new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      });
      scanBox.dispatchEvent(dropEvent);
    },
    { id: pieceId, mime: SCANBOX_DATA_MIME },
  );
  // Click Bind to confirm the scan. The button is auto-focused after the drop
  // so this resolves quickly.
  await sim.getByTestId('scan-box-bind').click();
}

/**
 * Click the "Learn track" button in the visualiser's LearnTrackPanel. The
 * button label toggles between "Learn track" (idle) and "Stop learning"
 * (active) — we target by testid so the label doesn't matter.
 */
export async function clickLearnTrack(vis: Page): Promise<void> {
  await vis.getByTestId('learn-track-button').click();
}
