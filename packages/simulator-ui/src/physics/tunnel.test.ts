import { describe, expect, it } from 'vitest';
import { coversPoint, darkTunnelOcclusion, makeTunnel } from './tunnel.js';

describe('makeTunnel', () => {
  it('defaults to a dark roof over a band wide enough to cover the track', () => {
    const t = makeTunnel({ id: 't', x0: 100, x1: 300, y: 600 });
    expect(t.lighting).toBe('dark');
    expect(t.halfWidth).toBeGreaterThan(0);
  });

  it('normalises a reversed span so x0 < x1', () => {
    const t = makeTunnel({ id: 't', x0: 300, x1: 100, y: 600 });
    expect(t.x0).toBe(100);
    expect(t.x1).toBe(300);
  });

  it('keeps an explicit lighting + half-width', () => {
    const t = makeTunnel({ id: 't', x0: 0, x1: 10, y: 0, lighting: 'lit', halfWidth: 12 });
    expect(t.lighting).toBe('lit');
    expect(t.halfWidth).toBe(12);
  });
});

describe('coversPoint', () => {
  const t = makeTunnel({ id: 't', x0: 100, x1: 300, y: 600, halfWidth: 50 });

  it('is true for a point under the roof', () => {
    expect(coversPoint(t, 200, 600)).toBe(true);
    expect(coversPoint(t, 200, 640)).toBe(true);
  });

  it('is false outside the covered span (before, after, off the band)', () => {
    expect(coversPoint(t, 90, 600)).toBe(false);
    expect(coversPoint(t, 310, 600)).toBe(false);
    expect(coversPoint(t, 200, 700)).toBe(false);
  });
});

describe('darkTunnelOcclusion', () => {
  it('occludes a point under a DARK tunnel but not under a LIT one', () => {
    const dark = makeTunnel({ id: 'd', x0: 0, x1: 100, y: 0, halfWidth: 20 });
    const lit = makeTunnel({ id: 'l', x0: 200, x1: 300, y: 0, halfWidth: 20, lighting: 'lit' });
    const occluded = darkTunnelOcclusion([dark, lit]);
    expect(occluded(50, 0)).toBe(true); // under the dark roof
    expect(occluded(250, 0)).toBe(false); // under the lit roof — not occluded
    expect(occluded(150, 0)).toBe(false); // between them — open sky
  });
});
