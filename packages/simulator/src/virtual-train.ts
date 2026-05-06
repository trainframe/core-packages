import type { LayoutState } from '@trainframe/core';
import type { VirtualClock } from './clock.js';
import type { SeededRandom } from './random.js';

interface RouteEdge {
  from_marker_id: string;
  to_marker_id: string;
}

export interface VirtualTrainConfig {
  /** Maximum velocity in mm/s. */
  max_velocity_mm_s: number;
  /** Acceleration in mm/s². */
  acceleration_mm_s2: number;
  /** Stopping distance noise factor (multiplicative, e.g. 0.1 = ±10%). */
  stopping_noise: number;
  /** Probability of missing a marker on traversal. */
  miss_rate: number;
  /** Detection latency in ms (mean, stddev). */
  detection_latency_ms: { mean: number; stddev: number };
}

export const DEFAULT_TRAIN_CONFIG: VirtualTrainConfig = {
  max_velocity_mm_s: 100, // 10 cm/s, slow toy speed
  acceleration_mm_s2: 200,
  stopping_noise: 0.05,
  miss_rate: 0.01,
  detection_latency_ms: { mean: 20, stddev: 5 },
};

interface TrainEvent {
  event_type: string;
  device_id: string;
  payload: unknown;
}

/**
 * A virtual train that simulates motion along edges and emits tag_observed
 * events as it crosses markers.
 *
 * Driven by `tick(dt_ms)`. Emits events via an injected sink.
 */
export class VirtualTrain {
  private velocity_mm_s = 0;
  private target_velocity_mm_s = 0;
  private current_edge: RouteEdge | null = null;
  private distance_into_edge_mm = 0;
  private route: ReadonlyArray<RouteEdge> = [];
  private route_index = 0;
  private clearance_limit_marker_id: string | null = null;

  constructor(
    private readonly device_id: string,
    private readonly config: VirtualTrainConfig,
    private readonly layout: LayoutState,
    private readonly random: SeededRandom,
    private readonly clock: VirtualClock,
    private readonly emit: (e: TrainEvent) => void,
  ) {}

  /** Place the train at the start of an edge with no route yet. */
  placeAt(edge: RouteEdge, distance_mm = 0): void {
    this.current_edge = edge;
    this.distance_into_edge_mm = distance_mm;
  }

  /** Apply commands sent by the scheduler. */
  acceptCommand(command_type: string, payload: unknown): void {
    switch (command_type) {
      case 'assign_route': {
        const { edges } = payload as { edges: RouteEdge[] };
        this.route = edges;
        this.route_index = 0;
        if (!this.current_edge && edges[0]) {
          this.current_edge = edges[0];
          this.distance_into_edge_mm = 0;
        }
        // Speed will be set when clearance arrives.
        break;
      }
      case 'grant_clearance': {
        const { limit_marker_id } = payload as { limit_marker_id: string };
        this.clearance_limit_marker_id = limit_marker_id;
        // If parked at end of current edge (= old limit), transition to next.
        if (
          this.current_edge &&
          this.distance_into_edge_mm >= 200 && // edge length, hardcoded for now
          this.velocity_mm_s === 0
        ) {
          const at_marker = this.current_edge.to_marker_id;
          const next_edge = this.route[this.route_index + 1];
          if (next_edge && next_edge.from_marker_id === at_marker) {
            this.route_index += 1;
            this.current_edge = next_edge;
            this.distance_into_edge_mm = 0;
          }
        }
        this.target_velocity_mm_s = this.config.max_velocity_mm_s;
        break;
      }
      case 'revoke_clearance': {
        this.clearance_limit_marker_id = null;
        this.target_velocity_mm_s = 0;
        break;
      }
      case 'emergency_stop':
        this.velocity_mm_s = 0;
        this.target_velocity_mm_s = 0;
        break;
    }
  }

  tick(dt_ms: number): void {
    const dt_s = dt_ms / 1000;

    // Adjust velocity toward target.
    if (this.velocity_mm_s < this.target_velocity_mm_s) {
      this.velocity_mm_s = Math.min(
        this.target_velocity_mm_s,
        this.velocity_mm_s + this.config.acceleration_mm_s2 * dt_s,
      );
    } else if (this.velocity_mm_s > this.target_velocity_mm_s) {
      this.velocity_mm_s = Math.max(
        this.target_velocity_mm_s,
        this.velocity_mm_s - this.config.acceleration_mm_s2 * dt_s,
      );
    }

    // Advance position.
    if (!this.current_edge) return;
    this.distance_into_edge_mm += this.velocity_mm_s * dt_s;

    const edge = this.layout.findEdge(
      this.current_edge.from_marker_id,
      this.current_edge.to_marker_id,
    );
    const edge_length_mm = edge?.estimated_length_mm ?? 200;

    // Check if we should be braking based on clearance limit.
    if (
      this.clearance_limit_marker_id &&
      this.clearance_limit_marker_id === this.current_edge.to_marker_id &&
      this.velocity_mm_s > 0
    ) {
      const distance_to_limit_mm = edge_length_mm - this.distance_into_edge_mm;
      // Compute kinematic stopping distance: v² / (2a). Velocity is mm/s,
      // accel is mm/s², so the result is in mm directly. Apply noise.
      const ideal_stopping_mm =
        (this.velocity_mm_s * this.velocity_mm_s) / (2 * this.config.acceleration_mm_s2);
      const stopping_distance_mm =
        ideal_stopping_mm * (1 + this.random.normal(0, this.config.stopping_noise));
      if (distance_to_limit_mm <= stopping_distance_mm) {
        this.target_velocity_mm_s = 0;
      }
    }

    // Crossed the end of the edge? Emit marker, transition.
    if (this.distance_into_edge_mm >= edge_length_mm) {
      const marker_id = this.current_edge.to_marker_id;
      this.emitMarkerObservation(marker_id);

      // If we just hit our clearance limit, park here. Don't transition until
      // clearance is extended (which will arrive via grant_clearance command).
      if (this.clearance_limit_marker_id === marker_id) {
        this.distance_into_edge_mm = edge_length_mm;
        this.velocity_mm_s = 0;
        this.target_velocity_mm_s = 0;
        return;
      }

      // Move to next edge if route allows.
      const next_edge = this.route[this.route_index + 1];
      if (next_edge && next_edge.from_marker_id === marker_id) {
        this.route_index += 1;
        this.current_edge = next_edge;
        this.distance_into_edge_mm = 0;
      } else {
        // End of route. Park here. No more ticks should emit anything.
        this.velocity_mm_s = 0;
        this.target_velocity_mm_s = 0;
        this.current_edge = null;
      }
    }
  }

  private emitMarkerObservation(marker_id: string): void {
    if (this.random.bernoulli(this.config.miss_rate)) return;
    const latency_ms = Math.max(
      0,
      this.random.normal(
        this.config.detection_latency_ms.mean,
        this.config.detection_latency_ms.stddev,
      ),
    );
    this.clock.schedule(latency_ms, () => {
      this.emit({
        event_type: 'tag_observed',
        device_id: this.device_id,
        payload: { tag_id: marker_id, direction: 'forward' },
      });
    });
  }

  // Observers for tests
  getVelocity(): number {
    return this.velocity_mm_s;
  }
  getDistanceIntoEdge(): number {
    return this.distance_into_edge_mm;
  }
  getCurrentEdge(): RouteEdge | null {
    return this.current_edge;
  }
}
