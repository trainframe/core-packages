import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase-3 migration invariant (ADR-035): EVERY platform-bearing device registers
 * its identity through the one shared `registerDevice` seam — never by calling
 * `platform.register(...)` itself. This is what makes the Phase-2 pairing
 * lifecycle a single change point rather than a per-device edit, and what the
 * completeness audit verified. This test pins it: if a new (or migrated) device
 * starts calling `.register(` on its platform directly, it fails here.
 *
 * `registerable-device.ts` is the seam itself — the ONE allowed registrar.
 * Runtime `publish` calls (state changes, telemetry) are out of scope; only the
 * registration entry point is gated.
 */
const DEVICES_DIR = new URL('.', import.meta.url).pathname;

describe('device registration goes through the registerDevice seam (ADR-035 Phase 3)', () => {
  it('no device source calls platform.register directly — only the seam does', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DEVICES_DIR)) {
      if (!file.endsWith('.ts')) continue;
      if (file.endsWith('.test.ts')) continue;
      if (file === 'registerable-device.ts' || file === 'platform-provider.ts') continue;
      const src = readFileSync(`${DEVICES_DIR}${file}`, 'utf8');
      /* Match a direct registration call on a platform (`.register(` preceded by
         `platform`), which only the seam should make. */
      if (/\bplatform\.register\s*\(/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `these devices register outside registerDevice: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
