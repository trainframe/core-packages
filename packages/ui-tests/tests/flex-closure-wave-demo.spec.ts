import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { TrackPiece } from '@trainframe/simulator';
import { getEndpoints } from '@trainframe/simulator';
import { openSimulatorUi, placePieceOnToyTable } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * END-TO-END loop closure, driven entirely by real mouse events, recorded to
 * video (the goal's clause 3 demo).
 *
 * This overturns the limitation the older toybox-flex-closure.spec.ts documented
 * ("end-to-end closure is not driveable through mouse events alone"). With the
 * LILLABO straight variants, an UNEVEN STADIUM OVAL (sides 150/110) lays a ~40 mm
 * closing gap that sits in the flex band (above auto-snap 30 mm, below capture
 * 60 mm). A slow drag of the open end bends the chain live and, on mouse-up, the
 * loop closes and the wave animates across it.
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
    const tooBig = fracs.some(([fx, fy]) => fx < 0.05 || fx > 0.95 || fy < 0.05 || fy > 0.95);
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

    test('a slow drag flexes an uneven oval shut and the wave runs across it', async ({
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

      /* Safety: if the centred oval still clips an edge, gently zoom out until the
       whole loop is on-screen (usually a no-op given the centred seed). */
      await zoomToFit(sim, [
        [215, seedY],
        [725, seedY],
        [215, seedY + ovalH],
        [725, seedY + ovalH],
      ]);

      const lastFree = await endpointOf(sim, lastCurve, 'curve', 1);

      /* Disarm so a pointer-down on a piece starts a drag, not a placement. */
      await sim.getByRole('button', { name: 'Curve', exact: true }).click();
      /* Hold on the REST-OPEN oval so the recording has a clear "before" the bend —
       the gap at the top is visible and the chain is at its rest shape. */
      await sim.waitForTimeout(600);

      /* Grab the last curve's free END and slow-drag it toward the first piece's
       entry. Each step is a few px over 70 ms — far under DRAG_FLEX_MAX_SPEED
       (1.5 px/ms) — so every move flexes. We step gently and RELEASE as soon as
       the solver flags the loop closeable (after a few visible steps of bending),
       rather than dragging all the way onto the target and overshooting the
       closeable window. */
      const grab = await mmToPx(sim, lastFree.x, lastFree.y);
      const target = await mmToPx(sim, firstEntry.x, firstEntry.y);
      /* Pull the free end most of the way to the target (not all the way — the rest
       geometry keeps the joint open so it never auto-snaps, but stopping short of
       coincidence keeps the closure SOLVE the thing that shuts the loop). The
       whole left side of the oval visibly bends as the gap closes — flex, not a
       rigid translate, because the anchor (the top straight) stays put. */
      await sim.mouse.move(grab.x, grab.y);
      await sim.mouse.down();
      /* Pull to ~45% of the gap: enough that the left side of the oval visibly
       bends (flex), but inside the window where the closing SOLVE stays feasible
       (a position-only follow that over-pulls rotates the free end's heading off
       anti-parallel, which the closure solve then can't satisfy within budget). */
      const STEPS = 14;
      const FRAC = 0.35;
      for (let s = 1; s <= STEPS; s++) {
        const x = grab.x + ((target.x - grab.x) * FRAC * s) / STEPS;
        const y = grab.y + ((target.y - grab.y) * FRAC * s) / STEPS;
        await sim.mouse.move(x, y);
        await sim.waitForTimeout(90);
      }

      /* The real solver reports the loop closeable — the dragged piece flashes. */
      await expect(sim.locator('[data-closure-available="true"]')).toHaveCount(1);

      /* Hold at the bent shape so the recording captures the flex clearly. */
      await sim.waitForTimeout(400);

      /* Release: the loop closes and the one-shot wave mounts and animates
         (~2.2s — see ToyTable's ClosureWave durationMs). */
      await sim.mouse.up();
      await expect(sim.getByTestId('closure-wave')).toBeVisible();
      /* Hold past the full wave duration so the recording captures the entire
         traversal with margin (the pulse must be seen at many positions). */
      await sim.waitForTimeout(3000);

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
