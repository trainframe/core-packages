import type { LayoutIntent } from '../capability.js';
import type { DeviceTable } from './devices.js';
import { type SchedulerEffect, effects } from './effects.js';
import type { LayoutState } from './layout-state.js';
import type { ClearanceRetry, MarkerOwnership } from './seams.js';
import type { EdgeRef } from './types.js';

export { SWITCH_ACTUATION_TIMEOUT_MS } from '../builtins/controls-switch.js';

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
 * The scheduler's side of junction actuation. Capabilities decide when to
 * command their hardware and when a request is overdue; this applies what they
 * report to the layout and asks the device bound to a junction to move it.
 * Clearance asks it whether an edge needs the points moved; it never grants
 * clearance itself.
 */
export class SwitchControl {
  constructor(
    private readonly layout: SwitchLayout,
    private readonly devices: Pick<DeviceTable, 'requestActuation' | 'anyActuationOverdue'>,
    private readonly ownership: Pick<MarkerOwnership, 'zoneOwnerOf'>,
    private readonly retry: ClearanceRetry,
    private readonly now: () => number,
  ) {}

  /** Apply a capability's `bind_junction` or `report_switch_position` intent. */
  applyIntent(intent: LayoutIntent, deviceId: string): ReadonlyArray<SchedulerEffect> {
    switch (intent.kind) {
      case 'bind_junction':
        return this.bind(deviceId, intent.junction_marker_id, intent.valid_positions);
      case 'report_switch_position':
        return this.adoptReport(intent.junction_marker_id, intent.position, intent.confirmed);
    }
  }

  /**
   * Bind a junction to the device that actuates it. A marker a `core.gates_zone`
   * frame already owns (ADR-034) is NOT routable from outside: the binding is
   * refused and an anomaly raised, so nothing fights the frame for a switch
   * under it.
   */
  private bind(
    deviceId: string,
    junctionMarkerId: string,
    validPositions: ReadonlyArray<string> | undefined,
  ): ReadonlyArray<SchedulerEffect> {
    const owner = this.ownership.zoneOwnerOf(junctionMarkerId);
    if (owner !== undefined && owner !== deviceId) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Device ${deviceId} cannot control marker ${junctionMarkerId}: it is owned by zone device ${owner}`,
        }),
      ];
    }
    this.layout.recordSwitchPairing(deviceId, junctionMarkerId);
    /* Without the junction record, discovery never populates
       `junctionMarkerIds()` and LearnMode cannot survey it. */
    if (validPositions !== undefined) this.layout.recordJunction(junctionMarkerId, validPositions);
    return [];
  }

  /**
   * Always republished as retained state; a confirmed position is adopted into
   * the layout and blocked clearances are retried, since the points may now
   * suit a waiting train.
   */
  private adoptReport(
    junctionMarkerId: string,
    position: string,
    confirmed: boolean,
  ): ReadonlyArray<SchedulerEffect> {
    if (!this.layout.hasMarker(junctionMarkerId)) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `switch_state_changed references unknown junction marker: ${junctionMarkerId}`,
        }),
      ];
    }
    const state = effects.updateState('switches', junctionMarkerId, { position, confirmed });
    if (!confirmed) return [state];
    this.layout.setSwitchPosition(junctionMarkerId, position);
    return [state, ...this.retry.retryBlockedClearances()];
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
   * The edge needs the junction in a position it isn't confirmed to be in. If a
   * device is bound to the junction, ask it to move the points; its capability
   * decides whether that sends anything. The caller still WITHHOLDS clearance:
   * the confirmed report adopts the position and retries, and that pass finds
   * the edge now matches.
   *
   * With no device bound, nothing is sent: the junction's position must be
   * changed by some other agent (operator, learn mode) before the train can
   * proceed.
   */
  actuate(edge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    const layoutEdge = this.layout.findEdge(edge.from_marker_id, edge.to_marker_id);
    const required = layoutEdge?.requires_switch_state;
    if (!required) return [];

    const deviceId = this.layout.switchDeviceForMarker(edge.from_marker_id);
    if (deviceId === undefined) return [];

    return this.devices.requestActuation({
      device_id: deviceId,
      junction_marker_id: edge.from_marker_id,
      position: required,
      now_ms: this.now(),
    });
  }

  /**
   * Ask the device bound to `junctionMarkerId` to move the points to `position`,
   * for an agent other than clearance (LearnMode). Same hooks as a routed throw,
   * so the request is tracked and re-sent when overdue. Empty with no device bound.
   */
  request(junctionMarkerId: string, position: string): ReadonlyArray<SchedulerEffect> {
    const deviceId = this.layout.switchDeviceForMarker(junctionMarkerId);
    if (deviceId === undefined) return [];
    return this.devices.requestActuation({
      device_id: deviceId,
      junction_marker_id: junctionMarkerId,
      position,
      now_ms: this.now(),
    });
  }

  /** True when some device's actuation has gone unconfirmed long enough to be re-sent. */
  anyRequestOverdue(): boolean {
    return this.devices.anyActuationOverdue(this.now());
  }

  /**
   * Drop the junctions a departing device was bound to, so a replacement is
   * asked afresh and nothing is sent to the dead one. What the device had
   * requested lives in its capability state and goes with it.
   */
  forgetDevice(deviceId: string): void {
    this.layout.forgetSwitchDevice(deviceId);
  }
}
