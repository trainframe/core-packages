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
 * In the toy-table flow that is always `M-{piece.id}`, and the device_id for
 * the virtual switch is the same value — matching the device_id that
 * LearnMode addresses when it sends `set_switch_position` commands (which use
 * the junction marker id as the target device).
 */
export class VirtualSwitch {
  constructor(
    private readonly device_id: string,
    private readonly junction_marker_id: string,
    private readonly emit: (e: SwitchEvent) => void,
  ) {}

  /** Initial registration call. Announces `core.controls_switch`. */
  register(): void {
    this.emit({
      event_type: 'device_registered',
      device_id: this.device_id,
      payload: { capabilities: ['core.controls_switch'] },
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
