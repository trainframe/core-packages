import { type TrainState, initialTrainState, occupiedEdges } from './train-state.js';
import { type EdgeRef, anyEdgeSharesMarker, edgeSharesMarker } from './types.js';

/**
 * Every train the scheduler knows, in registration order, together with the
 * queries that read one train's held clearance against its peers. Block
 * exclusivity (ADR-011), deadlock detection and the introduction conflict check
 * all ask "does another train hold track here?"; this is the one place that
 * walks the peers' occupied edges to answer.
 */
export class TrainRoster {
  private readonly trains = new Map<string, TrainState>();
  /**
   * Monotonic counter handed to each train the first time it registers, the
   * source of the FIFO-by-arrival floor in the total order over trains
   * (ADR-017). Re-registration of an already-known train does NOT consume a
   * number, so arrival order is stable across reconnects.
   */
  private nextRegistrationSeq = 0;

  get(trainId: string): TrainState | undefined {
    return this.trains.get(trainId);
  }

  ids(): ReadonlyArray<string> {
    return [...this.trains.keys()];
  }

  /** Trains in registration order. */
  values(): IterableIterator<TrainState> {
    return this.trains.values();
  }

  /** Trains in the explicit total order of ADR-017 §1, preferred first. */
  ordered(): ReadonlyArray<TrainState> {
    return [...this.trains.values()].sort(compareTrains);
  }

  /**
   * Add a train the first time it registers, resolving its announced priority
   * (default 0), and record a positive announced length. A reconnecting train
   * keeps its state and its place in the arrival order.
   */
  register(trainId: string, priority: number | undefined, lengthMm: number | undefined): void {
    if (!this.trains.has(trainId)) {
      this.trains.set(
        trainId,
        initialTrainState(trainId, this.nextRegistrationSeq++, priority ?? 0),
      );
    }
    if (lengthMm !== undefined && lengthMm > 0) {
      const train = this.trains.get(trainId);
      if (train) {
        train.length_mm = lengthMm;
      }
    }
  }

  remove(trainId: string): void {
    this.trains.delete(trainId);
  }

  clear(): void {
    this.trains.clear();
    this.nextRegistrationSeq = 0;
  }

  /**
   * Two sections conflict when they share either boundary marker. A train
   * holding `A→B` therefore locks markers A and B; any edge whose `from` or
   * `to` is A or B is denied to other trains. ADR-011.
   */
  edgeConflictsWithAnotherTrain(trainId: string, edge: EdgeRef): boolean {
    for (const [otherId, other] of this.trains) {
      if (otherId === trainId) continue;
      for (const held of occupiedEdges(other)) {
        if (edgeSharesMarker(held, edge)) return true;
      }
    }
    return false;
  }

  /** True if any train OTHER than `trainId` holds an edge touching `marker`. */
  markerHeldByAnotherTrain(trainId: string, marker: string): boolean {
    for (const [otherId, other] of this.trains) {
      if (otherId === trainId) continue;
      for (const held of occupiedEdges(other)) {
        if (held.from_marker_id === marker || held.to_marker_id === marker) return true;
      }
    }
    return false;
  }

  /** The trains other than `trainId` whose held edges deny it `wanted`, in registration order. */
  trainsBlocking(trainId: string, wanted: EdgeRef): string[] {
    const blockers: string[] = [];
    for (const [otherId, other] of this.trains) {
      if (otherId === trainId) continue;
      if (anyEdgeSharesMarker(occupiedEdges(other), wanted)) blockers.push(otherId);
    }
    return blockers;
  }
}

/**
 * The total order over trains for section contention and deadlock victim
 * selection (ADR-017 §1). Pure and total: announced priority desc, then
 * registration-sequence asc (FIFO floor), then `train_id` lexicographic.
 * Negative when `a` ranks ahead of (is preferred over) `b`. No clock, no RNG,
 * so the same event stream produces the same grants every run.
 */
export function compareTrains(a: TrainState, b: TrainState): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.registration_seq !== b.registration_seq) {
    return a.registration_seq - b.registration_seq;
  }
  return a.train_id < b.train_id ? -1 : a.train_id > b.train_id ? 1 : 0;
}
