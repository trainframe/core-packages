import { describe, expect, it } from 'vitest';
import { CORE_COMMAND_SCHEMAS } from '../commands.js';
import { CORE_EVENT_SCHEMAS } from '../events.js';
import {
  ANOMALY_TYPE_ID,
  COMMAND_TYPE_ORDER,
  EVENT_TYPE_ORDER,
  MAX_COMPACT_ID,
  TCF_REGISTRY_EPOCH,
  commandTypeToId,
  eventTypeToId,
  idToCommandType,
  idToEventType,
} from './registry.js';

/*
 * The anti-drift contract (ADR-021 §3): the compact-ID registry must stay in
 * exact one-to-one correspondence with the JSON event/command schema maps. CI
 * fails the moment a new type lands without a compact ID, or an ID exists for a
 * type that no longer ships.
 */
describe('TCF registry anti-drift', () => {
  /*
   * Append-only / never-renumbered stability (ADR-021 §3). The set-equality
   * checks below catch add/remove drift, but they cannot catch an *insert or
   * reorder* that silently renumbers IDs and breaks wire-compat with deployed
   * devices. These literal snapshots are the real enforcement: a legitimate
   * append forces a deliberate edit here (and a reminder to bump the epoch);
   * any reorder fails loudly. Only ever append to the end of these literals.
   */
  it('pins the exact event ID order (append-only — never reorder)', () => {
    expect([...EVENT_TYPE_ORDER]).toEqual([
      'device_registered',
      'tag_observed',
      'marker_traversed',
      'vehicle_identified',
      'train_status',
      'clearance_request',
      'clearance_granted',
      'clearance_revoked',
      'gate_state_changed',
      'switch_state_changed',
      'aspect_changed',
      'tag_assignment',
      'anomaly',
      'topology_violation',
      'zone_state_changed',
      'train_length_changed',
    ]);
  });

  it('pins the exact command ID order (append-only — never reorder)', () => {
    expect([...COMMAND_TYPE_ORDER]).toEqual([
      'assign_route',
      'grant_clearance',
      'revoke_clearance',
      'begin_exploration',
      'set_target_speed',
      'emergency_stop',
      'set_switch_position',
      'set_aspect',
      'hold_gate',
      'release_gate',
      'assign_tag',
      'grant_reverse',
    ]);
  });

  it('maps every core event type exactly once and vice versa', () => {
    const schemaTypes = new Set(Object.keys(CORE_EVENT_SCHEMAS));
    const registryTypes = new Set<string>(EVENT_TYPE_ORDER);
    expect(registryTypes).toEqual(schemaTypes);
    /* No duplicates: the ordered array length matches the set size. */
    expect(EVENT_TYPE_ORDER.length).toBe(registryTypes.size);
  });

  it('maps every core command type exactly once and vice versa', () => {
    const schemaTypes = new Set(Object.keys(CORE_COMMAND_SCHEMAS));
    const registryTypes = new Set<string>(COMMAND_TYPE_ORDER);
    expect(registryTypes).toEqual(schemaTypes);
    expect(COMMAND_TYPE_ORDER.length).toBe(registryTypes.size);
  });

  it('pins device_registered at the lowest event ID (stable across epochs)', () => {
    expect(eventTypeToId('device_registered')).toBe(0);
    expect(idToEventType(0)).toBe('device_registered');
  });

  it('keeps all compact IDs within one byte', () => {
    expect(EVENT_TYPE_ORDER.length - 1).toBeLessThanOrEqual(MAX_COMPACT_ID);
    expect(COMMAND_TYPE_ORDER.length - 1).toBeLessThanOrEqual(MAX_COMPACT_ID);
  });

  it('round-trips event type <-> id for every event', () => {
    for (const [id, type] of EVENT_TYPE_ORDER.entries()) {
      expect(eventTypeToId(type)).toBe(id);
      expect(idToEventType(id)).toBe(type);
    }
  });

  it('round-trips command type <-> id for every command', () => {
    for (const [id, type] of COMMAND_TYPE_ORDER.entries()) {
      expect(commandTypeToId(type)).toBe(id);
      expect(idToCommandType(id)).toBe(type);
    }
  });

  it('returns undefined for unknown types and ids', () => {
    expect(eventTypeToId('not_a_real_event')).toBeUndefined();
    expect(commandTypeToId('not_a_real_command')).toBeUndefined();
    expect(idToEventType(250)).toBeUndefined();
    expect(idToCommandType(250)).toBeUndefined();
  });

  it('exposes a positive integer epoch', () => {
    expect(Number.isInteger(TCF_REGISTRY_EPOCH)).toBe(true);
    expect(TCF_REGISTRY_EPOCH).toBeGreaterThan(0);
  });

  it('points ANOMALY_TYPE_ID at the anomaly event', () => {
    expect(idToEventType(ANOMALY_TYPE_ID)).toBe('anomaly');
  });
});
