import { describe, expect, it } from 'vitest';
import { TagRegistry } from './tag-registry.js';

describe('TagRegistry', () => {
  it('resolves an assigned tag to its target entity', () => {
    const registry = new TagRegistry();
    registry.assign('TAG-001', { kind: 'marker', target_id: 'M1' });
    expect(registry.resolve('TAG-001')).toEqual({ kind: 'marker', target_id: 'M1' });
  });

  it('returns undefined for an unknown tag', () => {
    const registry = new TagRegistry();
    expect(registry.resolve('TAG-001')).toBeUndefined();
  });

  it('overwrites an existing binding when assign is called again', () => {
    const registry = new TagRegistry();
    registry.assign('TAG-001', { kind: 'marker', target_id: 'M1' });
    registry.assign('TAG-001', { kind: 'marker', target_id: 'M2' });
    expect(registry.resolve('TAG-001')?.target_id).toBe('M2');
  });

  it('can rebind a tag from marker to vehicle', () => {
    const registry = new TagRegistry();
    registry.assign('TAG-001', { kind: 'marker', target_id: 'M1' });
    registry.assign('TAG-001', { kind: 'vehicle', target_id: 'T1' });
    expect(registry.resolve('TAG-001')).toEqual({ kind: 'vehicle', target_id: 'T1' });
  });

  it('drops a binding via unassign', () => {
    const registry = new TagRegistry();
    registry.assign('TAG-001', { kind: 'marker', target_id: 'M1' });
    registry.unassign('TAG-001');
    expect(registry.resolve('TAG-001')).toBeUndefined();
  });

  it('unassign on an unknown tag is a no-op', () => {
    const registry = new TagRegistry();
    expect(() => registry.unassign('TAG-NEVER-SEEN')).not.toThrow();
  });

  it('entries() returns every binding', () => {
    const registry = new TagRegistry();
    registry.assign('TAG-A', { kind: 'marker', target_id: 'M1' });
    registry.assign('TAG-B', { kind: 'vehicle', target_id: 'T1' });
    const entries = registry.entries();
    expect(entries).toHaveLength(2);
    expect(new Map(entries).get('TAG-A')?.target_id).toBe('M1');
    expect(new Map(entries).get('TAG-B')?.target_id).toBe('T1');
  });
});
