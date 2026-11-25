import type { DeviceTable } from './devices.js';
import { type SchedulerEffect, effects } from './effects.js';
import type { LayoutState } from './layout-state.js';
import type { MarkerCrossings } from './seams.js';
import { TagRegistry } from './tag-registry.js';
import type { TrainRoster } from './train-roster.js';

/**
 * What the scheduler learns from identity reports: tag reads resolved through
 * the tag registry (ADR-007), the tag bindings `core.assigns_tags` devices
 * write, and a train's length as `core.reports_length` devices assert it
 * (ADR-023). Each report is honoured only from a device that declared the
 * capability authorising it.
 */
export class IdentityAndTags {
  private readonly tags = new TagRegistry();

  constructor(
    private readonly devices: Pick<DeviceTable, 'get' | 'stateEffect'>,
    private readonly trains: Pick<TrainRoster, 'get'>,
    private readonly layout: Pick<LayoutState, 'name' | 'hasMarker' | 'upsertMarker' | 'toLayout'>,
    private readonly crossings: MarkerCrossings,
  ) {}

  getTagRegistry(): TagRegistry {
    return this.tags;
  }

  reset(): void {
    this.tags.clear();
  }

  handleTagObserved(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { tag_id } = payload as { tag_id: string };

    const binding = this.tags.resolve(tag_id);
    if (!binding) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'info',
          description: `Unknown tag observed: ${tag_id} (not in the tag registry)`,
        }),
      ];
    }

    const device = this.devices.get(deviceId);
    if (!device) return [];

    // Each kind of read is honoured only from a device that declared the
    // matching capability, so a detector cannot move a train by being mistaken
    // for its reader.
    if (binding.kind === 'marker') {
      if (!device.capabilities.includes('core.reports_marker_traversal')) {
        return [this.undeclaredReadAnomaly(deviceId, 'core.reports_marker_traversal', tag_id)];
      }
      // A trackside reader has no train state to advance, so its read ends here.
      return device.capabilities.includes('core.controls_motion')
        ? this.crossings.handleTrainCrossing(deviceId, binding.target_id)
        : [];
    }

    if (!device.capabilities.includes('core.identifies_vehicles')) {
      return [this.undeclaredReadAnomaly(deviceId, 'core.identifies_vehicles', tag_id)];
    }
    return [
      effects.publishEvent('vehicle_identified', {
        vehicle_id: binding.target_id,
        context_device_id: deviceId,
      }),
    ];
  }

  private undeclaredReadAnomaly(
    deviceId: string,
    capabilityId: string,
    tagId: string,
  ): SchedulerEffect {
    return effects.publishEvent('anomaly', {
      severity: 'warning',
      description: `Device ${deviceId} reported tag ${tagId} without declaring ${capabilityId}; ignoring the read`,
    });
  }

  /**
   * Bind a tag to an entity. Only devices that declared `core.assigns_tags`
   * at registration may mutate the registry. Updates to the registry are
   * published as retained state so fresh subscribers see the world's tag
   * bindings.
   */
  handleTagAssignment(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { tag_id, assigned_kind, target_id, marker_kind } = payload as {
      tag_id: string;
      assigned_kind: 'marker' | 'vehicle';
      target_id: string;
      marker_kind?: string;
    };

    const device = this.devices.get(deviceId);
    if (!device || !device.capabilities.includes('core.assigns_tags')) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Device ${deviceId} attempted tag_assignment without core.assigns_tags`,
        }),
      ];
    }

    const out: SchedulerEffect[] = [];

    // Discovery (ADR-009): a marker assignment can point at a target that
    // doesn't yet exist in the layout. Create the marker on the fly so the
    // scheduler can route through it as soon as the train sees it again.
    if (assigned_kind === 'marker' && !this.layout.hasMarker(target_id)) {
      const kind = isMarkerKind(marker_kind) ? marker_kind : 'unspecified';
      const added = this.layout.upsertMarker(target_id, kind);
      if (added) {
        out.push(effects.updateState('layout', this.layout.name, this.layout.toLayout()));
      }
    }

    this.tags.assign(tag_id, { kind: assigned_kind, target_id });
    out.push(effects.updateState('tags', tag_id, { assigned_kind, target_id }));
    return out;
  }

  /**
   * Runtime train-length change (ADR-023). A device asserts a train's new
   * physical length; the producer need NOT be the train (a trackside station,
   * a railyard). Honoured only from a device that declared `core.reports_length`
   * — the same producer-authority gate `core.assigns_tags` uses. There is no
   * oracle for a train's length, so the capability gate is the whole trust
   * boundary; the value is trusted, only its structure is validated (protocol).
   *
   * On receipt we update `length_mm` and republish the train's retained device
   * state. Occupancy is NOT re-derived here: the tail-release walk needs the
   * head position, which the scheduler reads fresh from `train_status` rather
   * than persisting. A shorter train releases freed tail edges on its next
   * status (stopped trains keep emitting status); ADR-016's hold-don't-guess
   * asymmetry makes the brief over-hold always safe.
   */
  handleTrainLengthChanged(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { train_id, train_length_mm } = payload as {
      train_id: string;
      train_length_mm: number;
    };

    const reporter = this.devices.get(deviceId);
    if (!reporter || !reporter.capabilities.includes('core.reports_length')) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Device ${deviceId} attempted train_length_changed without core.reports_length`,
        }),
      ];
    }

    const train = this.trains.get(train_id);
    if (!train) return [];

    train.length_mm = train_length_mm;

    // Republish the TRAIN's retained device state (the reporter may be another
    // device). The snapshot replaces the previous one, so it is rebuilt whole.
    return [this.devices.stateEffect(train_id, train)];
  }
}

const VALID_MARKER_KINDS = new Set([
  'block_boundary',
  'station_stop',
  'junction',
  'terminus',
  'yard_entry',
  'unspecified',
]);

type MarkerKind =
  | 'block_boundary'
  | 'station_stop'
  | 'junction'
  | 'terminus'
  | 'yard_entry'
  | 'unspecified';

function isMarkerKind(value: unknown): value is MarkerKind {
  return typeof value === 'string' && VALID_MARKER_KINDS.has(value);
}
