import { expect, test } from '@playwright/test';
import type { TrackPiece } from '@trainframe/simulator';
import { getEndpoints } from '@trainframe/simulator';
import { openSimulatorUi, placePieceOnToyTable } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Toybox flex / chain-drag journey.
 *
 * The flex system lets an operator drag a chained piece to bend the chain live.
 * Connection is authoritative/geometric: a chain piece ALWAYS flexes and holds at
 * max flex (rubber-bands) when the cursor outruns its reach. There is no velocity
 * yank-detach — a fast drag flexes exactly like a slow one and never severs a
 * joint (covered deterministically by ToyTable.flex.test.tsx).
 *
 * One case is exercised here: a slow drag of a chained tail bends the chain and
 * the rendered transform changes, proving flex is live in the browser.
 *
 * Closure flash (`data-closure-available="true"`) and the wave
 * (`data-testid="closure-wave"`) are proven by unit tests in
 * ToyTable.flex.test.tsx and ClosureWave.test.tsx. The end-to-end closure
 * path requires a gap of < 60 mm between the chain's free end and an open
 * endpoint after applying flex. For standard Brio-style 45° curves, the
 * minimum gap on an open chain is ≈ 153 mm (7-curve 315° arc), which exceeds
 * CONNECT_CAPTURE_MM (60 mm), and any sub-30 mm gap auto-snaps the ring closed
 * at placement time. End-to-end closure is therefore not driveable through
 * mouse events alone; the unit-test path (controlled-timestamp pointer events
 * + mocked solveClose) is the correct guardrail for that path.
 */

/** Read a placed piece's rendered world transform (mm + degrees). */
async function readTransform(
  sim: import('@playwright/test').Page,
  id: string,
): Promise<{ x: number; y: number; deg: number }> {
  const t = await sim.locator(`[data-piece-id="${id}"]`).getAttribute('transform');
  const m =
    /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)(?:\s*scale\(1,\s*(-?1)\))?/.exec(
      t ?? '',
    );
  if (m === null) throw new Error(`no transform for ${id}: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), deg: Number(m[3]) };
}

/** The open exit endpoint of a freshly-placed piece (the endpoint farthest from `joinedAt`). */
async function openExitOf(
  sim: import('@playwright/test').Page,
  id: string,
  type: TrackPiece['type'],
  joinedAt: { x: number; y: number } | null,
): Promise<{ x: number; y: number }> {
  const t = await readTransform(sim, id);
  const piece: TrackPiece = {
    id,
    type,
    position: { x: t.x, y: t.y },
    rotationDeg: t.deg as TrackPiece['rotationDeg'],
    tagged: false,
  };
  const eps = getEndpoints(piece);
  if (joinedAt === null) {
    const ep = eps[1] ?? eps[0];
    if (ep === undefined) throw new Error(`no endpoints for ${id}`);
    return { x: ep.x, y: ep.y };
  }
  let best = eps[0];
  let bestD = -1;
  for (const ep of eps) {
    const d = Math.hypot(ep.x - joinedAt.x, ep.y - joinedAt.y);
    if (d > bestD) {
      bestD = d;
      best = ep;
    }
  }
  if (best === undefined) throw new Error(`no endpoints for ${id}`);
  return { x: best.x, y: best.y };
}

/** Convert a world-mm position to the client px coordinates Playwright needs. */
async function mmToClientPx(
  sim: import('@playwright/test').Page,
  xMm: number,
  yMm: number,
): Promise<{ clientX: number; clientY: number }> {
  const canvas = sim.getByTestId('toy-table-canvas');
  return canvas.evaluate(
    (el, { xMm, yMm }) => {
      const svg = el as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      const zoom = Number(svg.getAttribute('data-viewport-zoom') ?? '1');
      const vpX = Number(svg.getAttribute('data-viewport-x') ?? '0');
      const vpY = Number(svg.getAttribute('data-viewport-y') ?? '0');
      const canvasWMm = 900;
      const worldW = canvasWMm / zoom;
      const worldH = worldW * (rect.height / rect.width);
      const fracX = (xMm - vpX) / worldW;
      const fracY = (yMm - vpY) / worldH;
      return {
        clientX: Math.round(rect.left + fracX * rect.width),
        clientY: Math.round(rect.top + fracY * rect.height),
      };
    },
    { xMm, yMm },
  );
}

async function zoomOut(sim: import('@playwright/test').Page, steps: number) {
  const box = await sim.getByTestId('toy-table-canvas').boundingBox();
  if (box === null) throw new Error('canvas not visible');
  await sim.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await sim.mouse.wheel(0, 200);
    await sim.waitForTimeout(20);
  }
  await sim.waitForTimeout(200);
}

test.describe
  .serial('toybox: flex / closure / wave journey', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9115 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    /* -------------------------------------------------------------------------
     * Case 1: slow drag bends the chain live
     *
     * Build a 3-straight open chain (s0 → s1 → s2, end-to-end snapped). Drag
     * the tail piece (s2) SLOWLY — pointer-move cadence well under
     * DRAG_FLEX_MAX_SPEED (1.5 px/ms). The open chain cannot trigger
     * detectLoopClosure, so every move takes the slow path: solveFollow →
     * onDragFlex. On drag-end movePiece repositions s2 to the release point;
     * the piece's rendered transform changes, proving flex is live in the browser.
     * -------------------------------------------------------------------------*/
    test('a slow drag of a chained piece bends the chain (transform changes)', async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      await sim.setViewportSize({ width: 1280, height: 800 });
      /* Moderate zoom so pieces are visible and each 6 px step ≈ 4 mm world. */
      await zoomOut(sim, 3);

      /* Place three straights in a horizontal chain: s0 at (450, 300), then
       s1 and s2 each offset by 200 mm (one straight length) to the right.
       Straights exit exactly ±100 mm along the local x-axis (default rotation
       0° = eastward), so coordinates are predictable and stay within the
       visible world window at zoomOut(3). */
      const s0 = await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });
      const s0Exit = await openExitOf(sim, s0, 'straight', null);
      const s1 = await placePieceOnToyTable(sim, {
        type: 'straight',
        xMm: s0Exit.x,
        yMm: s0Exit.y,
      });
      const s1Exit = await openExitOf(sim, s1, 'straight', s0Exit);
      const s2 = await placePieceOnToyTable(sim, {
        type: 'straight',
        xMm: s1Exit.x,
        yMm: s1Exit.y,
      });
      await expect(sim.locator('[data-piece-id]')).toHaveCount(3);

      /* Disarm the armed piece type so pointer-down on a piece starts a drag
       instead of placing a new piece. */
      await sim.getByRole('button', { name: 'Straight', exact: true }).click();
      await expect(sim.getByRole('button', { name: 'Straight', exact: true })).toHaveAttribute(
        'aria-pressed',
        'false',
      );

      /* Read the rest-pose transform of the tail piece. */
      const before = await readTransform(sim, s2);
      const { clientX: cx, clientY: cy } = await mmToClientPx(sim, before.x, before.y);

      /* Drag the tail PERPENDICULAR to the chain (downward): a colinear pull has
       no rotational DOF to bend, so we pull across-axis to genuinely flex the
       joint. solveFollow bends the chain within budget; on release the bend is
       baked, so the tail's transform changes (rotation + position). */
      await sim.mouse.move(cx, cy);
      await sim.mouse.down();
      for (let step = 1; step <= 10; step++) {
        await sim.mouse.move(cx, cy + step * 6);
        await sim.waitForTimeout(50);
      }
      await sim.mouse.up();
      /* One render tick to commit the repositioning. */
      await sim.waitForTimeout(100);

      /* The tail piece must have moved (repositioned to the release point). */
      const after = await readTransform(sim, s2);
      const changed =
        Math.abs(after.x - before.x) > 0.01 ||
        Math.abs(after.y - before.y) > 0.01 ||
        Math.abs(after.deg - before.deg) > 0.01;
      expect(changed, 'piece transform must change during a slow flex drag').toBe(true);

      /* Slow drag does not detach — all 3 pieces remain. */
      await expect(sim.locator('[data-piece-id]')).toHaveCount(3);
    });

    /* The old "fast yank frees the piece" case was removed with the velocity
     * yank-detach heuristic. Connection is now authoritative/geometric: a fast
     * drag flexes exactly like a slow one and never severs a joint. That claim is
     * covered deterministically by the jsdom component test ("a fast drag flexes
     * too, never severs") and end-to-end by flex-closure-wave-demo.spec.ts. */
  });
