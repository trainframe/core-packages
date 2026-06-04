interface SwitchEvent {
  event_type: string;
  device_id: string;
  payload: unknown;
}

/**
 * A no-op virtual switch motor. Accepts `set_switch_position` commands and
 * echoes back a `switch_state_changed` event with `confirmed: true`. This is
 * enough for LearnMode's auto-flip path to observe that the switch moved.
 *
 * The `junction_marker_id` identifies which junction this motor is paired with.
 * The device is registered under its own device id (e.g. `SWITCH-{piece.id}`)
 * with a `controls_marker_id` field in the `device_registered` payload, so
 * the server can resolve the marker → device pairing without magic naming
 * conventions. LearnMode addresses `set_switch_position` commands to the
 * device id (not the marker id); `switch_state_changed` still carries the
 * `junction_marker_id` so the scheduler can update its switch-position map.
 */
export class VirtualSwitch {
  constructor(
    private readonly device_id: string,
    private readonly junction_marker_id: string,
    private readonly emit: (e: SwitchEvent) => void,
  ) {}

  /**
   * Initial registration call. Announces `core.controls_switch` and
   * declares `controls_marker_id` so the server records the pairing between
   * this device and its junction marker.
   */
  register(): void {
    this.emit({
      event_type: 'device_registered',
      device_id: this.device_id,
      payload: {
        capabilities: ['core.controls_switch'],
        controls_marker_id: this.junction_marker_id,
      },
    });
  }

  /**
   * Accept a `set_switch_position` command and echo back `switch_state_changed`
   * with `confirmed: true`. The server's scheduler calls
   * `LayoutState.setSwitchPosition` on `confirmed` events, enabling clearance
   * re-evaluation for edges that `requires_switch_state`.
   */
  acceptCommand(command_type: string, payload: unknown): void {
    if (command_type !== 'set_switch_position') return;
    const { position } = payload as { position: string };
    this.emit({
      event_type: 'switch_state_changed',
      device_id: this.device_id,
      payload: {
        junction_marker_id: this.junction_marker_id,
        position,
        confirmed: true,
      },
    });
  }
}
