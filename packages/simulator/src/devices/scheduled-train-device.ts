/**
 * A SCHEDULER-DRIVEN loco (FROZEN SPEC §3). Unlike the manual-mode `TrainDevice`
 * stub (which the yard interior drives directly), this device is a full citizen
 * of the real core: it registers a manifest + length, obeys `assign_route` /
 * `grant_clearance` / `revoke_clearance` / `grant_reverse` / `emergency_stop`,
 * and reports its progress with `tag_observed` (per marker crossing) and
 * `train_status` (each tick it ran motion). It NEVER resolves switches and NEVER
 * runs bespoke choreography — it only drives forward within its clearance, backs
 * up only under an explicit `grant_reverse`, reports markers, and stops at the
 * cleared limit. "Clearance, not commands": absent a grant it stays stopped.
 *
 * Position is DEAD-RECKONED: the device holds NO world ground truth. It believes
 * it is on a known route edge, integrates a nominal distance from that edge's
 * start as it runs, and SNAPS that belief to a fix each time its marker sensor
 * reports a crossing (a real loco resets odometry at each tag it reads). The
 * simulator owns the truth; the device only senses marker crossings and
 * commands its motor.
 *
 * The device↔core link is a `PlatformProvider` (ADR-031); the world link is a
 * `MotorActuator` + a `MarkerSensor` (ADR-030). DOM-free, deterministic.
 */
import {
  type AssignRoute,
  type BeginExploration,
  type CoreCommand,
  type CoreEvent,
  type DeviceManifest,
  type GrantClearance,
  type GrantReverse,
  type Layout,
  PROTOCOL_VERSION,
  type SetTargetSpeed,
} from '@trainframe/protocol';
import type { Motion } from '../physics/observation.js';
import type { MarkerSensor } from './marker-sensor.js';
import type { MotorActuator } from './motor-actuator.js';
import type { PlatformProvider } from './platform-provider.js';

/** A directed marker-pair edge — the protocol's `EdgeRef` shape, derived from the
 *  `assign_route` payload (the protocol package exports no standalone type). */
type RouteEdge = AssignRoute['payload']['edges'][number];

/** A loco's driving state, snapshotted across a world rebuild (see
 *  `snapshotDrive`/`restoreDrive`) so a running train survives a track edit. */
export interface TrainDriveState {
  readonly route: readonly RouteEdge[];
  readonly progress: number;
  readonly distance: number;
  readonly limitMarker: string | undefined;
  readonly intent: Motion;
  readonly speedScale: number;
  readonly reversing: boolean;
  readonly exploring: boolean;
}

export interface ScheduledTrainDeps {
  /** The device↔core link (mqtt in the gate/script, in-process in unit tests). */
  readonly platform: PlatformProvider;
  /** The world actuator the device drives its motor through. */
  readonly motor: MotorActuator;
  /** The trackside-marker reader for this loco's body. */
  readonly sensor: MarkerSensor;
  /** The compiled layout — edge lengths for dead reckoning. */
  readonly layout: Layout;
  /** Physical nose-to-tail length (mm), reported so the scheduler defers
   *  tail-release until the tail has vacated. */
  readonly lengthMm: number;
  /** Whether the loco declares `core.can_reverse` (a prerequisite for zone
   *  admission and the only thing that lets `grant_reverse` move it). */
  readonly canReverse: boolean;
  /** Nominal forward speed (mm/s) the device assumes for dead reckoning. A real
   *  loco knows only its motor state, not its speed; this is its best guess. */
  readonly nominalSpeedMmS?: number;
  /** Fresh envelope id source. Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Current ISO-8601 timestamp source. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

/** Default dead-reckoning speed (mm/s) — the device's assumed running pace. */
const DEFAULT_NOMINAL_SPEED = 220;

export class ScheduledTrainDevice {
  private readonly id: string;
  private readonly d: ScheduledTrainDeps;
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly nominalSpeed: number;

  /** The assigned route's edges (a cycle). Empty until `assign_route`. */
  private route: readonly RouteEdge[] = [];
  /** Index into `route` of the edge the device believes its head is on. */
  private progress = 0;
  /** Dead-reckoned distance (mm) along the current edge since its start. */
  private distance = 0;
  /** The marker the device is cleared up to, or undefined when held. */
  private limitMarker: string | undefined;
  /** Motion the device is currently commanding. */
  private intent: Motion = 'stopped';
  /** Speed scale [0,1] from `set_target_speed` (default full). */
  private speedScale = 1;
  /** Whether the current clearance is a reverse grant (bounded backing up). */
  private reversing = false;
  /** Cold-start discovery (ADR-015): driving forward across markers with no route
   *  or limit, emitting `tag_observed` per crossing so the server's LearnMode maps
   *  the loop. Ends on `revoke_clearance` / `emergency_stop` / `assign_route`. The
   *  device picks no edges — the physical switches route it; the sensor reports
   *  whatever marker it actually crosses. */
  private exploring = false;
  /** Power state. A powered-OFF loco is inert in place: it commands its motor
   *  stopped, then falls SILENT (no `train_status`, no marker reports, ignores
   *  commands) WITHOUT disconnecting — so the scheduler, hearing silence rather
   *  than a `device_disconnected`, keeps its block reserved and a follower stalls
   *  behind it. Powering back on resumes it toward its last clearance. */
  private powered = true;

  private offCommand: (() => void) | undefined;
  private offSensor: (() => void) | undefined;

  constructor(deviceId: string, deps: ScheduledTrainDeps) {
    this.id = deviceId;
    this.d = deps;
    this.newId = deps.newId ?? defaultNewId;
    this.now = deps.now ?? defaultNow;
    this.nominalSpeed = deps.nominalSpeedMmS ?? DEFAULT_NOMINAL_SPEED;
  }

  get deviceId(): string {
    return this.id;
  }

  /** The motor state the device is currently commanding (for tests/inspection). */
  get motion(): Motion {
    return this.intent;
  }

  /** Whether the loco has power (for tests/inspection). */
  get isPowered(): boolean {
    return this.powered;
  }

  /**
   * Switch the loco's power. Off: command the motor stopped (the body coasts to
   * rest and sits as an inert obstacle) and fall silent — no heartbeat, no marker
   * reports, commands ignored — but stay registered (no disconnect), so the
   * scheduler keeps the block reserved. On: resume toward the last granted limit.
   */
  power(on: boolean): void {
    if (on === this.powered) return;
    this.powered = on;
    if (!on) {
      this.drive('stopped');
      return;
    }
    if (this.limitMarker !== undefined && !this.headIsAtMarker(this.limitMarker)) {
      this.drive(this.reversing ? 'reverse' : 'forward');
    }
  }

  /** The device's belief of the edge its head is on, or undefined before a route. */
  get currentEdge(): RouteEdge | undefined {
    return this.route[this.progress];
  }

  /** Register the manifest + length, and start listening to core + the sensor. */
  start(): void {
    this.d.platform.register(this.manifest());
    /* The scheduler reads `train_length_mm` off a `device_registered` event
     *  payload; `mqttPlatform.register` ships only capabilities + kind, so we
     *  also publish the event carrying the length (the existing convention). */
    this.d.platform.publish(this.registeredEvent());
    this.offCommand = this.d.platform.onCommand((command) => this.handle(command));
    this.offSensor = this.d.sensor.onMarker((markerId, direction) =>
      this.onMarker(markerId, direction),
    );
  }

  stop(): void {
    this.offCommand?.();
    this.offSensor?.();
    this.offCommand = undefined;
    this.offSensor = undefined;
  }

  /**
   * Capture the driving state — route, clearance, odometry, motion — so a loco
   * can be carried across a world rebuild (the toy-table recompiles the physics
   * net when the operator edits track). Editing track elsewhere must not stop or
   * rewind a running train; the body pose is restored separately by the host.
   */
  snapshotDrive(): TrainDriveState {
    return {
      route: this.route,
      progress: this.progress,
      distance: this.distance,
      limitMarker: this.limitMarker,
      intent: this.intent,
      speedScale: this.speedScale,
      reversing: this.reversing,
      exploring: this.exploring,
    };
  }

  /** Re-assert a snapshotted driving state onto a freshly-respawned device (its
   *  body already re-seeded at the captured pose), so it resumes mid-run. */
  restoreDrive(state: TrainDriveState): void {
    this.route = state.route;
    this.progress = state.progress;
    this.distance = state.distance;
    this.limitMarker = state.limitMarker;
    this.speedScale = state.speedScale;
    this.reversing = state.reversing;
    this.exploring = state.exploring;
    /* `drive` re-asserts the motion intent through the (new world's) motor. */
    this.drive(state.intent);
  }

  /** Motion intent each tick. Samples the sensor, dead-reckons forward (or
   *  backward under a reverse grant) within the current clearance when moving, and
   *  publishes a `train_status` heartbeat EVERY tick once it has a route.
   *
   *  The heartbeat fires even when stopped: a real loco reports its state
   *  continuously, and — crucially — the scheduler's ADR-028 station dwell resumes
   *  a PARKED train only when it observes a fresh `train_status` after the dwell
   *  elapses. A device that fell silent while stopped would never be resumed past a
   *  scheduled stop, stalling the cyclic schedule. */
  step(dtS: number): void {
    if (!this.powered) return;
    this.d.sensor.sample();
    if (this.intent !== 'stopped') {
      const speed = this.nominalSpeed * this.speedScale;
      this.distance += (this.reversing ? -speed : speed) * dtS;
      if (this.distance < 0) this.distance = 0;
      this.clampToEdgeLength();
    }
    if (this.route.length > 0 || this.exploring) this.publishStatus();
  }

  // ---- command handling -------------------------------------------------

  /** Dispatch a core command, narrowing by its `command_type` (see `narrow`). */
  private handle(command: CoreCommand): void {
    if (!this.powered) return;
    const route = narrow<AssignRoute>(command, 'assign_route');
    if (route !== undefined) {
      this.onAssignRoute(route);
      return;
    }
    const grant = narrow<GrantClearance>(command, 'grant_clearance');
    if (grant !== undefined) {
      this.onGrantClearance(grant.payload.limit_marker_id);
      return;
    }
    if (command.command_type === 'revoke_clearance') {
      this.onRevoke();
      return;
    }
    const rev = narrow<GrantReverse>(command, 'grant_reverse');
    if (rev !== undefined) {
      this.onGrantReverse(rev);
      return;
    }
    if (command.command_type === 'emergency_stop') {
      this.exploring = false;
      this.drive('stopped');
      this.limitMarker = undefined;
      return;
    }
    if (narrow<BeginExploration>(command, 'begin_exploration') !== undefined) {
      this.onBeginExploration();
      return;
    }
    const speed = narrow<SetTargetSpeed>(command, 'set_target_speed');
    if (speed !== undefined) this.speedScale = speed.payload.speed_normalised;
    /* Other commands (set_switch_position, gate, tag) are not for a loco. */
  }

  /** Store the route (a cycle), reset progress, and set heading from edge 0. No
   *  motion — the train waits for clearance. */
  private onAssignRoute(command: AssignRoute): void {
    this.exploring = false;
    this.route = command.payload.edges;
    this.progress = 0;
    this.distance = 0;
    this.reversing = false;
    this.drive('stopped');
    this.limitMarker = undefined;
    /* Announce the heading so the scheduler seeds direction from a real facing. */
    this.publishStatus();
  }

  /** Record the cleared limit; roll forward if it lies ahead of the head. */
  private onGrantClearance(limitMarkerId: string): void {
    this.reversing = false;
    this.limitMarker = limitMarkerId;
    if (this.headIsAtMarker(limitMarkerId)) {
      /* Already at the limit — nothing further is cleared, stay put. */
      this.drive('stopped');
      return;
    }
    this.drive('forward');
  }

  private onRevoke(): void {
    this.exploring = false;
    this.drive('stopped');
    this.limitMarker = undefined;
  }

  /** Begin cold-start discovery: shed any route/limit and drive forward. The loco
   *  runs until the server revokes clearance (LearnMode stops it when the loop is
   *  fully mapped) — it never stops at a limit because there is none. */
  private onBeginExploration(): void {
    this.exploring = true;
    this.route = [];
    this.progress = 0;
    this.distance = 0;
    this.reversing = false;
    this.limitMarker = undefined;
    this.drive('forward');
  }

  /** The ONLY path to reverse: bounded by the granted limit + edges. Ignored if
   *  the loco cannot reverse. */
  private onGrantReverse(command: GrantReverse): void {
    if (!this.d.canReverse) return;
    this.reversing = true;
    this.limitMarker = command.payload.limit_marker_id;
    this.drive('reverse');
  }

  // ---- marker crossings -------------------------------------------------

  /** A marker crossing: publish `tag_observed`, advance the route belief if it is
   *  the current edge's far end, and stop if it is the cleared limit. */
  private onMarker(markerId: string, direction: 'forward' | 'reverse'): void {
    this.d.platform.publish(this.tagObservedEvent(markerId, direction));
    const edge = this.currentEdge;
    if (edge !== undefined && markerId === edge.to_marker_id) {
      this.advanceEdge();
    } else if (edge !== undefined && markerId === edge.from_marker_id) {
      /* Re-fix odometry at the edge's own start (e.g. just departed). */
      this.distance = 0;
    }
    if (this.limitMarker !== undefined && markerId === this.limitMarker) {
      /* Reached the cleared limit: hold here until a fresh grant arrives. */
      this.drive('stopped');
    }
  }

  /** Hold the dead-reckoned distance at the believed edge's length until the next
   *  marker fix arrives — odometry never claims the head has run PAST the edge it
   *  is on without a tag to confirm the crossing (the marker is the truth). */
  private clampToEdgeLength(): void {
    const edge = this.currentEdge;
    if (edge === undefined) return;
    const len = this.layoutEdgeLength(edge);
    if (len !== undefined && this.distance > len) this.distance = len;
  }

  /** The estimated length (mm) of a route edge from the compiled layout. */
  private layoutEdgeLength(edge: RouteEdge): number | undefined {
    for (const e of this.d.layout.edges) {
      if (e.from_marker_id === edge.from_marker_id && e.to_marker_id === edge.to_marker_id) {
        return e.estimated_length_mm;
      }
    }
    return undefined;
  }

  /** Step the route belief to the next edge (cyclic) and reset odometry. */
  private advanceEdge(): void {
    if (this.route.length === 0) return;
    this.progress = (this.progress + 1) % this.route.length;
    this.distance = 0;
  }

  /** Whether the head currently sits at `markerId` (the start of the edge it
   *  believes it is on). */
  private headIsAtMarker(markerId: string): boolean {
    const edge = this.currentEdge;
    return edge !== undefined && edge.from_marker_id === markerId && this.distance === 0;
  }

  // ---- motor + status ---------------------------------------------------

  private drive(motion: Motion): void {
    this.intent = motion;
    this.d.motor.set(motion);
  }

  private publishStatus(): void {
    this.d.platform.publish(this.trainStatusEvent());
  }

  // ---- envelopes --------------------------------------------------------

  private manifest(): DeviceManifest {
    return {
      manifest_version: '1.0',
      vendor: 'trainframe.sim',
      device_kind: 'scheduled-loco',
      version: '0.1.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: `Loco ${this.id}`,
      description: 'A scheduler-driven locomotive.',
      capabilities: this.d.canReverse
        ? ['core.controls_motion', 'core.can_reverse']
        : ['core.controls_motion'],
    };
  }

  private registeredEvent(): CoreEvent {
    return this.envelope('device_registered', {
      capabilities: this.manifest().capabilities,
      device_kind_hint: 'scheduled-loco',
      train_length_mm: this.d.lengthMm,
    });
  }

  private tagObservedEvent(markerId: string, direction: 'forward' | 'reverse'): CoreEvent {
    return this.envelope('tag_observed', { tag_id: markerId, direction });
  }

  private trainStatusEvent(): CoreEvent {
    const edge = this.currentEdge;
    const payload: Record<string, unknown> = {
      train_id: this.id,
      speed_normalised: this.intent === 'stopped' ? 0 : this.speedScale,
      estimated_distance_from_edge_start_mm: Math.abs(this.distance),
    };
    if (edge !== undefined) payload.current_edge = edge;
    return this.envelope('train_status', payload);
  }

  /**
   * Build a `CoreEvent` envelope. THE single sound coercion point in this file:
   * `device_registered` carries an extra `train_length_mm`/capability shape and
   * `train_status` carries an optional `current_edge`, all modelled by open
   * TypeBox objects (the scheduler reads the fields it needs; extras survive
   * validation on the wire). We type `payload` as the open record it really is
   * and coerce the assembled envelope to the `CoreEvent` union once, here, rather
   * than sprinkling casts. `event_type` is constrained to the union's literals so
   * the discriminant is always valid.
   */
  private envelope(
    eventType: CoreEvent['event_type'],
    payload: Readonly<Record<string, unknown>>,
  ): CoreEvent {
    const env = {
      event_id: this.newId(),
      device_id: this.id,
      timestamp_device: this.now(),
      event_type: eventType,
      protocol_version: PROTOCOL_VERSION,
      payload,
    };
    return env as unknown as CoreEvent;
  }
}

/**
 * Narrow a `CoreCommand` to a specific envelope by its `command_type`. The
 * protocol's `CoreCommand` is NOT a TS discriminated union — each envelope's
 * `command_type` is typed `string`, not a literal — so the compiler cannot
 * narrow on it directly, and `Value.Check` is unusable here (its schemas demand
 * UUID-format marker ids, which real layouts like `M-yard-throat` are not). This
 * is the single, sound coercion point: when the runtime `command_type` matches,
 * the wire contract guarantees the payload has the matching shape (the producer
 * built it that way and the edge already validated structure), so the cast to
 * `T` is sound. Confined here, named, and commented — never sprinkled.
 */
function narrow<T extends CoreCommand>(
  command: CoreCommand,
  type: T['command_type'],
): T | undefined {
  return command.command_type === type ? (command as T) : undefined;
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}
