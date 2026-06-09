/**
 * Theme-token Playwright spec.
 *
 * Verifies that the visualiser's --tf-vis-color-* CSS custom properties
 * resolve to the expected values in light mode (default) and that they change
 * when data-theme="dark" is applied to <html>.
 *
 * Why Playwright and not vitest/jsdom: CSS custom-property cascade and
 * external-stylesheet resolution require a real browser. jsdom's
 * getComputedStyle does not resolve var() through imported stylesheets, so
 * any jsdom theme test would pass without actually testing anything.
 *
 * This spec does NOT require a running broker or harness — it only opens the
 * visualiser page and reads cascade-computed values.
 */
import { expect, test } from '@playwright/test';
import { VISUALISER_URL } from '../playwright.config.js';

async function openThemeTestPage(page: import('@playwright/test').Page): Promise<void> {
  // Seed localStorage so the visualiser doesn't try to connect to a default
  // broker and produce noisy console errors. Theme CSS loads regardless.
  await page.addInitScript(() => {
    localStorage.setItem('trainframe.visualiser.brokerUrl', 'ws://127.0.0.1:19999');
  });
  await page.goto(VISUALISER_URL);
  // Wait for the page's <main> to be present — CSS is loaded by this point.
  await page.locator('main').waitFor({ state: 'attached' });
}

/** Read a single CSS custom property from :root in the page's context. */
async function getCssVar(page: import('@playwright/test').Page, name: string): Promise<string> {
  return page.evaluate(
    (varName) => getComputedStyle(document.documentElement).getPropertyValue(varName).trim(),
    name,
  );
}

test.describe('Visualiser theme tokens', () => {
  test('light theme (default): --tf-vis-color-marker is the warm marker cream', async ({
    page,
  }) => {
    await openThemeTestPage(page);

    const markerColor = await getCssVar(page, '--tf-vis-color-marker');
    // The light theme sets the warm "workshop" marker puck (ADR-017): #fdf6e6.
    // Chromium normalises hex colours to rgb(...) in getComputedStyle.
    expect(markerColor).toMatch(/^#?fdf6e6$|^rgb\(253,\s*246,\s*230\)$/i);
  });

  test('dark theme: --tf-vis-color-marker changes when data-theme="dark" is set', async ({
    page,
  }) => {
    await openThemeTestPage(page);

    const lightColor = await getCssVar(page, '--tf-vis-color-marker');

    // Switch to dark theme by setting the attribute on <html>.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    const darkColor = await getCssVar(page, '--tf-vis-color-marker');

    // The dark theme sets --tf-vis-color-marker: #2a2a2a — must differ from light.
    expect(darkColor).not.toBe(lightColor);
    expect(darkColor).not.toBe('');
  });

  test('dark theme: --tf-vis-color-warn-bg changes from light value', async ({ page }) => {
    await openThemeTestPage(page);

    const lightWarnBg = await getCssVar(page, '--tf-vis-color-warn-bg');

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    const darkWarnBg = await getCssVar(page, '--tf-vis-color-warn-bg');

    expect(darkWarnBg).not.toBe(lightWarnBg);
    expect(darkWarnBg).not.toBe('');
  });

  test('localStorage bootstrap: data-theme is pre-applied before main renders', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    // Pre-seed the theme preference via localStorage before the page loads.
    await ctx.addInitScript(() => {
      localStorage.setItem('trainframe.visualiser.brokerUrl', 'ws://127.0.0.1:19999');
      localStorage.setItem('tf-theme', 'dark');
    });
    const page = await ctx.newPage();
    await page.goto(VISUALISER_URL);
    await page.locator('main').waitFor({ state: 'attached' });

    // The IIFE in main.tsx must have applied data-theme="dark" from localStorage.
    const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
    expect(themeAttr).toBe('dark');

    // And the token should resolve to the dark value.
    const markerColor = await getCssVar(page, '--tf-vis-color-marker');
    // dark: #2a2a2a — definitely not white.
    expect(markerColor).not.toMatch(/^#?fff(fff)?$|^rgb\(255,\s*255,\s*255\)$/i);

    await ctx.close();
  });
});
