import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { TrackPiece } from '@trainframe/simulator';
import { getEndpoints } from '@trainframe/simulator';
import { openSimulatorUi, placePieceOnToyTable } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * END-TO-END loop-closure JOURNEY, driven entirely by real mouse events,
 * recorded to video (the demo artefact).
 *
 * Built from an UNEVEN STADIUM OVAL (LILLABO sides 150/110) whose ~40 mm closing
 * gap sits in the flex band (above auto-snap 30 mm, below capture 60 mm). The
 * journey, in three beats:
 *   1. drag the open-end curve OFF the ring and onto a SEPARATE straight sitting
 *      apart in the middle — the ring is now plainly open (a visible gap) and the
 *      curve is joined to a separate piece;
 *   2. bring the curve back onto the ring's open end (the ~40 mm gap restored);
 *   3. slow-flex the open end onto the first piece — the loop closes and the blue
 *      wave spreads around it.
 *
 * The recorded video is the artefact handed to the adversarial frame reviewer.
 */

/* The recorded demo lands in packages/ui-tests/videos/ (portable, repo-relative). */
const VIDEO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'videos');

type Pg = import('@playwright/test').Page;

async function readTransform(sim: Pg, id: string): Promise<{ x: number; y: number; deg: number }> {
  const t = await sim.locator(`[data-piece-id="${id}"]`).getAttribute('transform');
  const m = /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)/.exec(t ?? '');
  if (m === null) throw new Error(`no transform for ${id}: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), deg: Number(m[3]) };
}

/* Reconstruct a placed piece and return an endpoint (0 = entry, 1 = exit). */
async function endpointOf(
  sim: Pg,
  id: string,
  type: TrackPiece['type'],
  idx: number,
  lengthMm?: number,
): Promise<{ x: number; y: number }> {
  const t = await readTransform(sim, id);
  const piece: TrackPiece = {
    id,
    type,
    position: { x: t.x, y: t.y },
    rotationDeg: t.deg,
    tagged: false,
    ...(lengthMm !== undefined ? { lengthMm } : {}),
  };
  const ep = getEndpoints(piece)[idx];
  if (ep === undefined) throw new Error(`no endpoint ${idx} for ${id}`);
  return { x: ep.x, y: ep.y };
}

/* World mm → client px, using the canvas viewport attributes. */
async function mmToPx(sim: Pg, xMm: number, yMm: number): Promise<{ x: number; y: number }> {
  return sim.getByTestId('toy-table-canvas').evaluate(
    (el, p) => {
      const svg = el as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      const zoom = Number(svg.getAttribute('data-viewport-zoom') ?? '1');
      const vpX = Number(svg.getAttribute('data-viewport-x') ?? '0');
      const vpY = Number(svg.getAttribute('data-viewport-y') ?? '0');
      const worldW = 900 / zoom;
      const worldH = worldW * (rect.height / rect.width);
      return {
        x: rect.left + ((p.xMm - vpX) / worldW) * rect.width,
        y: rect.top + ((p.yMm - vpY) / worldH) * rect.height,
      };
    },
    { xMm, yMm },
  );
}

/* Zoom out in SMALL steps until every mm point sits within 15%..85% of the box
   (a snug fit with margin — coarse steps overshoot and shrink the loop to a few
   px, which makes the closing gap sub-pixel). */
async function zoomToFit(sim: Pg, points: ReadonlyArray<[number, number]>): Promise<void> {
  const box = await sim.getByTestId('toy-table-canvas').boundingBox();
  if (box === null) throw new Error('canvas not visible');
  for (let attempt = 0; attempt < 40; attempt++) {
    const fracs = await sim.getByTestId('toy-table-canvas').evaluate(
      (el, pts) => {
        const svg = el as SVGSVGElement;
        const rect = svg.getBoundingClientRect();
        const zoom = Number(svg.getAttribute('data-viewport-zoom') ?? '1');
        const vpX = Number(svg.getAttribute('data-viewport-x') ?? '0');
        const vpY = Number(svg.getAttribute('data-viewport-y') ?? '0');
        const worldW = 900 / zoom;
        const worldH = worldW * (rect.height / rect.width);
        return pts.map(([x, y]) => [(x - vpX) / worldW, (y - vpY) / worldH]);
      },
      points as [number, number][],
    );
    const tooBig = fracs.some((f) => {
      const fx = f[0] ?? 0.5;
      const fy = f[1] ?? 0.5;
      return fx < 0.05 || fx > 0.95 || fy < 0.05 || fy > 0.95;
    });
    if (!tooBig) return;
    await sim.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sim.mouse.wheel(0, 50);
    await sim.waitForTimeout(25);
  }
}

test.describe
  .serial('flex closure wave — recorded demo', () => {
    let harness: UiHarness;
    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9117 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('open a gap to a separate piece, bring it back, flex the loop shut → blue wave', async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      /* A TALL viewport so the wide toy-table canvas is itself tall enough to show
       the ~400 mm-tall oval large (at low zoom), making the flex and the wave
       clearly visible to a frame-by-frame reviewer. Video size matches. */
      const VW = 1280;
      const VH = 1040;
      const sim = await openSimulatorUi(browser, {
        brokerUrl: harness.brokerWsUrl,
        recordVideoDir: VIDEO_DIR,
        recordVideoSize: { width: VW, height: VH },
      });
      await sim.setViewportSize({ width: VW, height: VH });

      /* The oval is ~510 mm wide × 400 mm tall and grows DOWNWARD from its seed.
       Seed it so the whole loop sits vertically centred in the (wide) canvas at
       zoom 1 — that way it renders large without zooming out (zooming out to drag
       the bottom into view from the top would shrink the loop and make the flex
       and wave too small to see). */
      const worldH = await sim.getByTestId('toy-table-canvas').evaluate((el) => {
        const svg = el as SVGSVGElement;
        const r = svg.getBoundingClientRect();
        const zoom = Number(svg.getAttribute('data-viewport-zoom') ?? '1');
        return (900 / zoom) * (r.height / r.width);
      });
      const ovalH = 400;
      const seedX = 450;
      const seedY = Math.max(70, worldH / 2 - ovalH / 2);

      /* Build the uneven stadium oval by chaining each piece onto the previous
       piece's open exit, exactly as an operator clicks it out: side 150, four
       curves, side 110, four curves. */
      const s0 = await placePieceOnToyTable(sim, {
        type: 'straight',
        xMm: seedX,
        yMm: seedY,
        straightLengthMm: 150,
      });
      let exit = await endpointOf(sim, s0, 'straight', 1, 150);
      const firstEntry = await endpointOf(sim, s0, 'straight', 0, 150);

      const placeCurve = async (): Promise<void> => {
        const id = await placePieceOnToyTable(sim, { type: 'curve', xMm: exit.x, yMm: exit.y });
        exit = await endpointOf(sim, id, 'curve', 1);
      };
      await placeCurve();
      await placeCurve();
      await placeCurve();
      await placeCurve();

      const s5 = await placePieceOnToyTable(sim, {
        type: 'straight',
        xMm: exit.x,
        yMm: exit.y,
        straightLengthMm: 110,
      });
      exit = await endpointOf(sim, s5, 'straight', 1, 110);

      await placeCurve();
      await placeCurve();
      await placeCurve();
      /* The last curve — its open exit is the free end we drag onto firstEntry. */
      const lastCurve = await placePieceOnToyTable(sim, {
        type: 'curve',
        xMm: exit.x,
        yMm: exit.y,
      });
      await expect(sim.locator('[data-piece-id]')).toHaveCount(10);
      /* The last curve's REST centre — dropping it back here re-snaps its entry
         onto the 9th piece (its nearest open end) and restores the original ~40 mm
         closing gap, the flex-able near-closure the wave needs. */
      const c9Home = await readTransform(sim, lastCurve);

      /* Safety: if the centred oval still clips an edge, gently zoom out until the
       whole loop is on-screen (usually a no-op given the centred seed). */
      await zoomToFit(sim, [
        [215, seedY],
        [725, seedY],
        [215, seedY + ovalH],
        [725, seedY + ovalH],
      ]);

      /* A SEPARATE straight, free-standing in the middle of the oval — the piece
         the open end will be dragged out to before the loop is closed. */
      const sep = await placePieceOnToyTable(sim, {
        type: 'straight',
        xMm: seedX,
        yMm: seedY + 200,
      });
      const sepEnd = await endpointOf(sim, sep, 'straight', 0);
      await expect(sim.locator('[data-piece-id]')).toHaveCount(11);

      /* Disarm whatever toybox tile is armed (placing the separate straight left
         STRAIGHT armed) so a pointer-down on a piece starts a drag, not a
         placement. */
      const armedTile = sim.locator('[data-testid^="toybox-"][aria-pressed="true"]').first();
      if ((await armedTile.count()) > 0) await armedTile.click();
      await expect(sim.locator('[data-testid^="toybox-"][aria-pressed="true"]')).toHaveCount(0);
      /* Hold on the rest layout — the near-closed oval with its open end, and the
         separate straight sitting apart in the middle. */
      await sim.waitForTimeout(700);

      /* ── Beat 1: open a VISIBLE GAP and connect to the separate piece ──
         Yank the last curve off the ring (a fast pull detaches it) and carry it to
         the separate straight, where it snaps on. The ring is now plainly open —
         a whole curve's worth of gap between the two ends — and the carried curve
         is joined to a separate piece. */
      const c9a = await readTransform(sim, lastCurve);
      const grabA = await mmToPx(sim, c9a.x, c9a.y);
      const sepPx = await mmToPx(sim, sepEnd.x, sepEnd.y);
      await sim.mouse.move(grabA.x, grabA.y);
      await sim.mouse.down();
      await sim.mouse.move(grabA.x + 5, grabA.y, { steps: 1 }); // baseline (speed 0)
      await sim.waitForTimeout(20);
      await sim.mouse.move(grabA.x + 60, grabA.y - 40, { steps: 1 }); // fast → yank/detach
      await sim.mouse.move(sepPx.x, sepPx.y, { steps: 8 }); // carry to the separate straight
      await sim.mouse.up();
      await sim.waitForTimeout(900); // hold: gap open, curve on the separate piece

      /* ── Beat 2: bring the curve BACK onto the ring's open end ── */
      const c9b = await readTransform(sim, lastCurve);
      const grabB = await mmToPx(sim, c9b.x, c9b.y);
      const backPx = await mmToPx(sim, c9Home.x, c9Home.y);
      await sim.mouse.move(grabB.x, grabB.y);
      await sim.mouse.down();
      await sim.mouse.move(grabB.x + 5, grabB.y, { steps: 1 });
      await sim.waitForTimeout(20);
      await sim.mouse.move(grabB.x + 60, grabB.y + 30, { steps: 1 }); // yank off the separate piece
      await sim.mouse.move(backPx.x, backPx.y, { steps: 8 }); // carry back to the ring
      await sim.mouse.up();
      await sim.waitForTimeout(700); // hold: near-closed oval restored

      /* ── Beat 3: FLEX the open end onto the first piece → close → wave ──
         The curve is back at its rest pose, so the ~40 mm closing gap is restored
         (verified: dropping it at its home centre re-snaps its entry to the 9th
         piece, leaving the free end one flex-budget from the first piece). */
      const lastFree = await endpointOf(sim, lastCurve, 'curve', 1);
      const grab = await mmToPx(sim, lastFree.x, lastFree.y);
      const target = await mmToPx(sim, firstEntry.x, firstEntry.y);
      await sim.mouse.move(grab.x, grab.y);
      await sim.mouse.down();
      const STEPS = 14;
      const FRAC = 0.35; // inside the window where the closing solve stays feasible
      for (let s = 1; s <= STEPS; s++) {
        const x = grab.x + ((target.x - grab.x) * FRAC * s) / STEPS;
        const y = grab.y + ((target.y - grab.y) * FRAC * s) / STEPS;
        await sim.mouse.move(x, y);
        await sim.waitForTimeout(90);
      }
      /* The real solver reports the loop closeable — the dragged piece flashes. */
      await expect(sim.locator('[data-closure-available="true"]')).toHaveCount(1);
      await sim.waitForTimeout(400); // hold the flexed-shut shape

      /* Release: the loop closes and the blue wave spreads around it (~2.2s). */
      await sim.mouse.up();
      await expect(sim.getByTestId('closure-wave')).toBeVisible();
      await sim.waitForTimeout(3000); // capture the full wave traversal

      /* Save + report the video path for the adversarial frame review. */
      const video = sim.video();
      await sim.close();
      if (video !== null) {
        const path = await video.path();
        // eslint-disable-next-line no-console
        console.log(`DEMO_VIDEO_PATH=${path}`);
      }
    });
  });
