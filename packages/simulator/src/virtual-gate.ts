interface GateEvent {
  event_type: string;
  device_id: string;
  payload: unknown;
}

/**
 * The simplest possible virtual gate. Holds withhold/grant state per marker
 * and emits events when state changes. Tests drive it via withhold/release
 * methods.
 */
export class VirtualGate {
  private readonly withheld = new Set<string>();

  constructor(
    private readonly device_id: string,
    private readonly emit: (e: GateEvent) => void,
  ) {}

  /** Initial registration call. */
  register(): void {
    this.emit({
      event_type: 'device_registered',
      device_id: this.device_id,
      payload: { capabilities: ['core.gates_clearance'] },
    });
  }

  withhold(marker_id: string, reason = 'gate'): void {
    if (this.withheld.has(marker_id)) return;
    this.withheld.add(marker_id);
    this.emit({
      event_type: 'gate_state_changed',
      device_id: this.device_id,
      payload: { marker_id, state: 'withholding', reason },
    });
  }

  release(marker_id: string): void {
    if (!this.withheld.has(marker_id)) return;
    this.withheld.delete(marker_id);
    this.emit({
      event_type: 'gate_state_changed',
      device_id: this.device_id,
      payload: { marker_id, state: 'granting' },
    });
  }

  /**
   * Honour server-side overrides of local gate logic. `hold_gate` forces a
   * withhold; `release_gate` clears it. The gate then publishes a normal
   * `gate_state_changed` event so the rest of the system observes the same
   * shape it would for any other transition.
   */
  acceptCommand(command_type: string, payload: unknown): void {
    switch (command_type) {
      case 'hold_gate': {
        const { marker_id, reason } = payload as { marker_id: string; reason?: string };
        this.withhold(marker_id, reason ?? 'server override');
        break;
      }
      case 'release_gate': {
        const { marker_id } = payload as { marker_id: string };
        this.release(marker_id);
        break;
      }
    }
  }
}
