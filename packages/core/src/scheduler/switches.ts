import { type SchedulerEffect, effects } from './effects.js';
import type { LayoutState } from './layout-state.js';
import type { MarkerOwnership } from './seams.js';
import type { EdgeRef } from './types.js';

/**
 * How long (injected-clock ms) a `set_switch_position` may go unconfirmed before
 * the scheduler sends it again. A lost or ignored command would otherwise leave
 * a train waiting at the junction forever, because the actuation is sent only
 * once per requested position. Point motors confirm well inside this.
 */
export const SWITCH_ACTUATION_TIMEOUT_MS = 3_000;

/** The parts of the layout switch control reads and writes. */
export type SwitchLayout = Pick<
  LayoutState,
  | 'findEdge'
  | 'hasMarker'
  | 'recordSwitchPairing'
  | 'recordJunction'
  | 'switchDeviceForMarker'
  | 'forgetSwitchDevice'
  | 'getSwitchPosition'
  | 'setSwitchPosition'
>;

/**
 * Pairing junctions to `core.controls_switch` devices, throwing points for a
 * route, re-sending an actuation left unconfirmed, and adopting confirmed
 * positions. Clearance asks it whether an edge needs the points moved and has
 * it actuate them; it never grants clearance itself.
 */
export class SwitchControl {
  /**
   * Per-junction switch position we have most recently *requested* via a
   * `set_switch_position` command (junction marker id → requested position).
   * Used for actuation idempotency: the clearance retry fires on many events,
   * so we must issue the command only when the required position differs from
   * what we've already asked for, never once per retry while the switch is
   * mid-move. Synced to reality on confirmed `switch_state_changed`.
   */
  private readonly requestedPositions = new Map<string, string>();
  /**
   * When each still-unconfirmed `set_switch_position` was sent (junction marker
   * id → injected-clock ms). Cleared on a confirmed `switch_state_changed`; an
   * entry older than `SWITCH_ACTUATION_TIMEOUT_MS` is re-sent on the next retry.
   */
  private readonly unconfirmedRequests = new Map<string, number>();

  constructor(
    private readonly layout: SwitchLayout,
    private readonly ownership: Pick<MarkerOwnership, 'zoneOwnerOf'>,
    private readonly now: () => number,
  ) {}

  /**
   * Record the junction marker → switch device pairing when a device declares
   * `core.controls_switch` with a `controls_marker_id` field. The field is
   * optional and non-breaking for devices that omit it. A marker a `core.gates_zone`
   * frame already owns (ADR-034) is NOT routable from outside: the pairing is
   * refused and an anomaly raised, so nothing fights the frame for a switch under it.
   */
  recordPairing(
    deviceId: string,
    controlsMarkerId: string | undefined,
    validPositions: ReadonlyArray<string> | undefined,
  ): ReadonlyArray<SchedulerEffect> {
    if (controlsMarkerId === undefined) return [];
    const owner = this.ownership.zoneOwnerOf(controlsMarkerId);
    if (owner !== undefined && owner !== deviceId) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Device ${deviceId} cannot control marker ${controlsMarkerId}: it is owned by zone device ${owner}`,
        }),
      ];
    }
    this.layout.recordSwitchPairing(deviceId, controlsMarkerId);
    /* ADR-035: a switch declaring its positions IS the discovery-mode evidence
       that its marker is a junction with those legs. Without this, discovery
       never populates `junctionMarkerIds()` and LearnMode cannot survey it. */
    if (validPositions !== undefined && validPositions.length > 0) {
      this.layout.recordJunction(controlsMarkerId, validPositions);
    }
    return [];
  }

  /**
   * Edge filtering by switch state. If the edge declares a
   * `requires_switch_state`, the junction's current position must match.
   * Unknown position counts as a mismatch (default-safe).
   */
  edgeRequiresMismatchedSwitch(edge: EdgeRef): boolean {
    const layoutEdge = this.layout.findEdge(edge.from_marker_id, edge.to_marker_id);
    const required = layoutEdge?.requires_switch_state;
    if (!required) return false;
    return this.layout.getSwitchPosition(edge.from_marker_id) !== required;
  }

  /**
   * The edge needs the junction in a position it isn't confirmed to be in.
   * If a switch device is paired to the junction, throw it: emit a single
   * `set_switch_position` command toward the edge's required position. The
   * caller still WITHHOLDS clearance; when the switch confirms,
   * `handleStateChanged` adopts the position and the caller's retry pass finds
   * it now matches.
   *
   * Idempotency: we send only when the required position differs from the one
   * we've already requested for this junction, or when that request has gone
   * unconfirmed for `SWITCH_ACTUATION_TIMEOUT_MS`.
   *
   * If no switch device is paired, nothing is sent: the junction's position
   * must be changed by some other agent (operator, learn mode) before the train
   * can proceed.
   */
  actuate(edge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    const layoutEdge = this.layout.findEdge(edge.from_marker_id, edge.to_marker_id);
    const required = layoutEdge?.requires_switch_state;
    if (!required) return [];

    const switchDeviceId = this.layout.switchDeviceForMarker(edge.from_marker_id);
    if (switchDeviceId === undefined) return [];

    const junction = edge.from_marker_id;
    const alreadyRequested = this.requestedPositions.get(junction) === required;
    if (alreadyRequested && !this.requestOverdue(junction)) return [];

    this.requestedPositions.set(junction, required);
    this.unconfirmedRequests.set(junction, this.now());
    const command = effects.sendCommand(switchDeviceId, 'set_switch_position', {
      junction_marker_id: junction,
      position: required,
    });
    if (!alreadyRequested) return [command];
    return [
      effects.publishEvent('anomaly', {
        severity: 'info',
        description: `Switch ${switchDeviceId} did not confirm ${junction} -> ${required} within ${SWITCH_ACTUATION_TIMEOUT_MS}ms; sending again`,
      }),
      command,
    ];
  }

  private requestOverdue(junctionMarkerId: string): boolean {
    const sentAt = this.unconfirmedRequests.get(junctionMarkerId);
    return sentAt !== undefined && this.now() - sentAt >= SWITCH_ACTUATION_TIMEOUT_MS;
  }

  /** True when some sent actuation has gone unconfirmed long enough to be re-sent. */
  anyRequestOverdue(): boolean {
    for (const junctionMarkerId of this.unconfirmedRequests.keys()) {
      if (this.requestOverdue(junctionMarkerId)) return true;
    }
    return false;
  }

  /**
   * A switch reported its position. Always republished as retained state; a
   * confirmed position is adopted into the layout. `confirmed` in the result
   * tells the caller the points may now suit a waiting train.
   */
  handleStateChanged(payload: unknown): {
    effects: SchedulerEffect[];
    confirmed: boolean;
  } {
    const { junction_marker_id, position, confirmed } = payload as {
      junction_marker_id: string;
      position: string;
      confirmed: boolean;
    };

    if (!this.layout.hasMarker(junction_marker_id)) {
      return {
        effects: [
          effects.publishEvent('anomaly', {
            severity: 'warning',
            description: `switch_state_changed references unknown junction marker: ${junction_marker_id}`,
          }),
        ],
        confirmed: false,
      };
    }

    const out: SchedulerEffect[] = [
      effects.updateState('switches', junction_marker_id, { position, confirmed }),
    ];
    if (confirmed) {
      this.layout.setSwitchPosition(junction_marker_id, position);
      // Sync our requested-position view to reality. If the switch landed on a
      // position we didn't request, the next retry is free to re-actuate; if it
      // landed on the one we requested, this is a no-op that keeps the
      // idempotency guard accurate.
      this.requestedPositions.set(junction_marker_id, position);
      this.unconfirmedRequests.delete(junction_marker_id);
    }
    return { effects: out, confirmed };
  }

  /**
   * Drop the junctions a departing switch device actuated, along with any
   * position we had asked it for, so a replacement device is asked afresh and
   * nothing is sent to the dead one.
   */
  forgetDevice(deviceId: string): void {
    for (const junctionMarkerId of this.layout.forgetSwitchDevice(deviceId)) {
      this.requestedPositions.delete(junctionMarkerId);
      this.unconfirmedRequests.delete(junctionMarkerId);
    }
  }

  reset(): void {
    this.requestedPositions.clear();
    this.unconfirmedRequests.clear();
  }
}
