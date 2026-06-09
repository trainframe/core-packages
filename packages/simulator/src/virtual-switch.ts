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
  /** Last confirmed position; undefined until the first set. */
  private position: string | undefined;

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
   * Seat the blade/deck at `position` and confirm it on the bus. The one entry
   * point for a position change, whether driven by a wire command
   * (`acceptCommand`) or a physical act on the device itself (the toy-table
   * operator spinning a turntable deck by hand) — either way the device's
   * honesty contract is the same: a `switch_state_changed` with
   * `confirmed: true` only once seated.
   */
  setPosition(position: string): void {
    this.position = position;
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

  /** The last confirmed position, or undefined before the first set. Lets a
   * renderer draw the device at its true mechanical state (e.g. a turntable
   * deck's angle) without parsing the event stream. */
  getPosition(): string | undefined {
    return this.position;
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
    this.setPosition(position);
  }
}
