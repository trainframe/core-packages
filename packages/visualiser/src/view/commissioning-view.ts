/**
 * Framework-independent COMMISSIONING data plane (garage device setup).
 *
 * When a real device appears on the bus it carries only its self-declared
 * capabilities — the human metadata (a friendly name, this loco's measured
 * length, what a track tag means) is supplied by the operator in the garage.
 * This view owns the *pending-commission queue* and the operator commands that
 * resolve it, then publishes the result onto the broker. It is entirely
 * React-free (the `use-commissioning` hook is a thin `useSyncExternalStore`
 * wrapper), so the e-paper / kid-facing frontend binds to the SAME logic.
 *
 * Persistence on `confirm`:
 *   - TRAIN / DEVICE: re-announce `device_registered` for the device with the
 *     operator name (+ measured length for a train). The server merges these
 *     into the retained `railway/state/devices/{id}` snapshot (protocol 0.12.0),
 *     so a late-joining display sees them. Capabilities are presentation-neutral
 *     — the scheduler still reasons on capabilities + topology only.
 *   - TRACK: bind the tag to a marker via a `tag_assignment` from the visualiser's
 *     own `core.assigns_tags` authority (the garage IS the tag authority), naming
 *     the marker. WHERE the marker sits is discovered later by driving — never here.
 *
 * Determinism: an injected `newId` + `now` (no `Date.now`/`Math.random`), so the
 * emitted envelopes are reproducible and the logic is unit-testable headless.
 */
import type { BrokerMessage, BrokerSubscriber } from '../broker/client.js';

/** PROTOCOL_VERSION is read from the protocol package so re-announced envelopes
 *  match the server's accepted version (a stale literal would be dropped). */
import { PROTOCOL_VERSION } from '@trainframe/protocol';

/** Operator classification of a scanned thing. Presentation grouping only — it
 *  decides which fields the operator supplies, never anything the scheduler reads.
 *  TRAIN is a special-cased DEVICE, surfaced first for accessibility. */
export type CommissionCategory = 'track' | 'train' | 'device';

/** A thing awaiting commissioning, with the operator's in-progress draft. */
export interface CommissionItem {
  readonly id: string;
  readonly source: 'device' | 'tag';
  readonly capabilities: ReadonlyArray<string>;
  /** Category suggested from what appeared (train if it drives motion, device if
   *  it has other capabilities, track for a bare tag). The operator can override. */
  readonly suggestedCategory: CommissionCategory;
  readonly category: CommissionCategory;
  readonly name: string;
  readonly trainLengthMm?: number;
  /** For a TRACK item: the marker this tag is being bound to. */
  readonly markerId?: string;
}

export interface CommissioningState {
  readonly pending: ReadonlyArray<CommissionItem>;
}

export interface CommissioningPorts {
  /** Subscribe to device/tag appearances AND publish the commissioned result. */
  readonly client: BrokerSubscriber;
  /** Deterministic id source for emitted envelopes (no Math.random). */
  readonly newId: () => string;
  /** Deterministic ISO timestamp for emitted envelopes (no Date.now). */
  readonly now: () => string;
  /** The visualiser's own tag-assigning authority device id (the garage). */
  readonly authorityId?: string;
}

type Listener = () => void;

interface Appearance {
  readonly source: 'device' | 'tag';
  readonly capabilities: ReadonlyArray<string>;
  /** A device whose retained snapshot already carries an operator name is
   *  commissioned — it drops out of the queue. */
  readonly named: boolean;
}

interface Draft {
  category?: CommissionCategory;
  name?: string;
  trainLengthMm?: number;
  markerId?: string;
}

const DEFAULT_AUTHORITY = 'VISUALISER-GARAGE';

/** A tag authority (`core.assigns_tags`) is infrastructure — the garage / admin
 *  that MINTS tag assignments — not a device an operator commissions. */
function isTagAuthority(capabilities: ReadonlyArray<string>): boolean {
  return capabilities.includes('core.assigns_tags');
}

/** Train if it drives motion; device if it has any other capability; track for a
 *  bare tag. The accessible default the operator usually accepts. */
function suggestCategory(
  source: 'device' | 'tag',
  capabilities: ReadonlyArray<string>,
): CommissionCategory {
  if (source === 'tag') return 'track';
  return capabilities.includes('core.controls_motion') ? 'train' : 'device';
}

export class CommissioningView {
  private state: CommissioningState = { pending: [] };
  private readonly listeners = new Set<Listener>();
  private readonly appearances = new Map<string, Appearance>();
  private readonly drafts = new Map<string, Draft>();
  /** Locally resolved (confirmed or dismissed) — drops from the queue at once,
   *  without waiting for the server's retained echo. */
  private readonly resolved = new Set<string>();
  private unsubDevices: (() => void) | null = null;
  private unsubTags: (() => void) | null = null;
  private authorityAnnounced = false;

  constructor(private readonly ports: CommissioningPorts) {}

  getState = (): CommissioningState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    if (this.listeners.size === 0) {
      this.unsubDevices = this.ports.client.subscribe('railway/state/devices/+', this.handleDevice);
      this.unsubTags = this.ports.client.subscribe('railway/events/tag_observed/+', this.handleTag);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubDevices?.();
        this.unsubTags?.();
        this.unsubDevices = null;
        this.unsubTags = null;
      }
    };
  };

  // -------------------- operator commands --------------------

  classify(id: string, category: CommissionCategory): void {
    this.editDraft(id, (d) => {
      d.category = category;
    });
  }
  setName(id: string, name: string): void {
    this.editDraft(id, (d) => {
      d.name = name;
    });
  }
  setTrainLength(id: string, mm: number): void {
    this.editDraft(id, (d) => {
      d.trainLengthMm = mm;
    });
  }
  bindTagToMarker(id: string, markerId: string): void {
    this.editDraft(id, (d) => {
      d.markerId = markerId;
    });
  }

  /** Persist the commissioned item: re-announce a device profile, or bind a tag. */
  confirm(id: string): void {
    const item = this.materialise(id);
    if (item === null) return;
    if (item.category === 'track') {
      this.bindTrack(item);
    } else {
      this.announceDevice(item);
    }
    this.resolved.add(id);
    this.recompute();
  }

  /** Drop an item from the queue without committing anything. */
  dismiss(id: string): void {
    this.resolved.add(id);
    this.recompute();
  }

  // -------------------- broker → queue --------------------

  private handleDevice = (message: BrokerMessage): void => {
    const id = message.topic.split('/').pop();
    if (!id) return;
    const decoded = decodeDevice(message.payload);
    if (decoded === null) {
      // Tombstone / malformed: forget the appearance.
      this.appearances.delete(id);
    } else if (isTagAuthority(decoded.capabilities)) {
      // Infrastructure that MINTS commissions (the toy table's GARAGE, the
      // server's ADMIN-API, the visualiser's own VISUALISER-GARAGE) — never a
      // thing an operator confirms. Keep it out of the queue (and drop it if it
      // was queued before declaring the capability).
      this.appearances.delete(id);
    } else {
      this.appearances.set(id, {
        source: 'device',
        capabilities: decoded.capabilities,
        named: decoded.named,
      });
    }
    this.recompute();
  };

  private handleTag = (message: BrokerMessage): void => {
    const tagId = decodeTagId(message.payload);
    if (tagId === null) return;
    if (this.appearances.has(tagId) || this.resolved.has(tagId)) return;
    this.appearances.set(tagId, { source: 'tag', capabilities: [], named: false });
    this.recompute();
  };

  // -------------------- internals --------------------

  private editDraft(id: string, mutate: (d: Draft) => void): void {
    const draft = this.drafts.get(id) ?? {};
    mutate(draft);
    this.drafts.set(id, draft);
    this.recompute();
  }

  /** Build the full item view (appearance + draft + defaults), or null if gone. */
  private materialise(id: string): CommissionItem | null {
    const appearance = this.appearances.get(id);
    if (appearance === undefined) return null;
    const draft = this.drafts.get(id) ?? {};
    const suggested = suggestCategory(appearance.source, appearance.capabilities);
    const item: CommissionItem = {
      id,
      source: appearance.source,
      capabilities: appearance.capabilities,
      suggestedCategory: suggested,
      category: draft.category ?? suggested,
      name: draft.name ?? '',
      ...(draft.trainLengthMm !== undefined ? { trainLengthMm: draft.trainLengthMm } : {}),
      ...(draft.markerId !== undefined ? { markerId: draft.markerId } : {}),
    };
    return item;
  }

  private recompute(): void {
    const pending: CommissionItem[] = [];
    for (const [id, appearance] of this.appearances) {
      if (this.resolved.has(id) || appearance.named) continue;
      const item = this.materialise(id);
      if (item !== null) pending.push(item);
    }
    pending.sort((a, b) => a.id.localeCompare(b.id));
    this.state = { pending };
    for (const listener of this.listeners) listener();
  }

  private publishEvent(deviceId: string, eventType: string, payload: unknown): void {
    const envelope = {
      event_id: this.ports.newId(),
      device_id: deviceId,
      timestamp_device: this.ports.now(),
      event_type: eventType,
      protocol_version: PROTOCOL_VERSION,
      payload,
    };
    this.ports.client.publish(
      `railway/events/${eventType}/${deviceId}`,
      new TextEncoder().encode(JSON.stringify(envelope)),
    );
  }

  /** Re-announce a device with its operator profile so the retained snapshot
   *  carries name (+ measured length for a train). */
  private announceDevice(item: CommissionItem): void {
    const payload: {
      capabilities: ReadonlyArray<string>;
      device_kind_hint: string;
      name?: string;
      train_length_mm?: number;
    } = { capabilities: item.capabilities, device_kind_hint: item.category };
    if (item.name.trim() !== '') payload.name = item.name.trim();
    if (item.category === 'train' && item.trainLengthMm !== undefined && item.trainLengthMm > 0) {
      payload.train_length_mm = item.trainLengthMm;
    }
    this.publishEvent(item.id, 'device_registered', payload);
  }

  /** Bind a tag to a marker via the garage's own assigns_tags authority. */
  private bindTrack(item: CommissionItem): void {
    const authority = this.ports.authorityId ?? DEFAULT_AUTHORITY;
    if (!this.authorityAnnounced) {
      this.publishEvent(authority, 'device_registered', {
        capabilities: ['core.assigns_tags'],
        device_kind_hint: 'tag-authority',
      });
      this.authorityAnnounced = true;
    }
    const payload: {
      tag_id: string;
      assigned_kind: 'marker';
      target_id: string;
      marker_name?: string;
    } = {
      tag_id: item.id,
      assigned_kind: 'marker',
      target_id: item.markerId ?? item.id,
    };
    if (item.name.trim() !== '') payload.marker_name = item.name.trim();
    this.publishEvent(authority, 'tag_assignment', payload);
  }
}

interface DecodedDevice {
  readonly capabilities: ReadonlyArray<string>;
  readonly named: boolean;
}

function decodeDevice(payload: Uint8Array): DecodedDevice | null {
  const obj = decodeJsonObject(payload);
  if (obj === null) return null;
  const caps = obj.capabilities;
  if (!Array.isArray(caps) || !caps.every((c): c is string => typeof c === 'string')) return null;
  return { capabilities: caps, named: typeof obj.name === 'string' && obj.name.length > 0 };
}

function decodeTagId(payload: Uint8Array): string | null {
  const obj = decodeJsonObject(payload);
  const inner = obj?.payload;
  if (inner === null || typeof inner !== 'object') return null;
  const tagId = (inner as { tag_id?: unknown }).tag_id;
  return typeof tagId === 'string' && tagId.length > 0 ? tagId : null;
}

function decodeJsonObject(payload: Uint8Array): Record<string, unknown> | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
