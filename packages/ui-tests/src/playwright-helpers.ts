import type { Browser, Page } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { SIM_URL, VISUALISER_URL } from '../playwright.config.js';

/**
 * Shared Playwright helpers for opening the visualiser and simulator-ui
 * in fresh browser contexts. Each helper seeds localStorage with the
 * broker (and, for the visualiser, admin API) URL the test harness expects,
 * mirroring what `multi-train-journey.spec.ts` does inline. New specs go
 * through these so we get the same setup everywhere.
 *
 * Keep this file browser-side only — anything Node-shaped (http server,
 * aedes, etc.) belongs in `test-harness.ts`.
 */

export interface OpenVisualiserOptions {
  /** Override the broker WS URL the visualiser connects to. */
  readonly brokerUrl?: string;
  /** Set the admin API URL the visualiser uses for tag assignments. */
  readonly adminApiUrl?: string;
}

export async function openVisualiser(
  browser: Browser,
  opts: OpenVisualiserOptions = {},
): Promise<Page> {
  const brokerUrl = opts.brokerUrl ?? 'ws://127.0.0.1:9001';
  const ctx = await browser.newContext();
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
  /**
   * Preset id to start with (e.g. `'simple-loop'`, `'long-loop'`). Either
   * `preset` or `layout` must be set; if both are omitted the sim UI loads
   * its default selection from localStorage.
   */
  readonly preset?: string;
  /** Inline custom Layout to start with. */
  readonly layout?: Layout;
}

export async function openSimulatorUi(
  browser: Browser,
  opts: OpenSimulatorUiOptions = {},
): Promise<Page> {
  const brokerUrl = opts.brokerUrl ?? 'ws://127.0.0.1:9001';
  const selection = opts.layout
    ? JSON.stringify({ kind: 'custom', layout: opts.layout })
    : opts.preset
      ? JSON.stringify({ kind: 'preset', preset_id: opts.preset })
      : null;
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ({ broker, sel }) => {
      localStorage.setItem('trainframe.simulator-ui.brokerUrl', broker);
      if (sel) localStorage.setItem('trainframe.simulator-ui.layout', sel);
    },
    { broker: brokerUrl, sel: selection },
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
