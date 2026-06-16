import type { BrokerClient } from '@trainframe/simulator/broker/client.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { useEffect, useRef } from 'react';
import { ToyHardware } from './toy-hardware.js';

interface UseToyHardwareArgs {
  readonly pieces: ReadonlyArray<TrackPiece>;
  readonly liveIds: ReadonlySet<string>;
  /** The subset of live trains the operator has powered OFF in place. */
  readonly poweredOffIds: ReadonlySet<string>;
  readonly client: BrokerClient;
  /**
   * Optional callback invoked after each RAF tick so callers can react to
   * the sim advancing. Used by the carriage-position driver to schedule a
   * React state bump when the train is moving.
   */
  readonly onTick?: () => void;
}

export interface UseToyHardwareResult {
  /** Stable ref to the live `ToyHardware` instance (null until first mount). */
  readonly hardwareRef: React.RefObject<ToyHardware | null>;
}

/**
 * Drives a `ToyHardware` instance from inside `ToyTable`. The hook owns the
 * `requestAnimationFrame` loop that advances the physics simulation, and
 * keeps the simulation in sync with whatever the operator is doing on the
 * canvas (placing pieces, scanning trains, powering devices off).
 *
 * Returns a stable ref to the hardware instance so callers can read the
 * current simulation state each render (e.g. for carriage position tracking).
 * Reading `getSimulation()` from the ref each render is safe — `syncLayout`
 * rebuilds the simulation on topology changes, but the ref itself is stable.
 */
export function useToyHardware({
  pieces,
  liveIds,
  poweredOffIds,
  client,
  onTick,
}: UseToyHardwareArgs): UseToyHardwareResult {
  const hardwareRef = useRef<ToyHardware | null>(null);
  const onTickRef = useRef<(() => void) | undefined>(onTick);
  onTickRef.current = onTick;

  // Construct the hardware once per `client`. Tearing it down when the
  // BrokerClient changes is the right thing; in production the client is
  // stable for the lifetime of the page.
  useEffect(() => {
    const hardware = new ToyHardware({ client });
    hardwareRef.current = hardware;
    return () => {
      hardware.dispose();
      hardwareRef.current = null;
    };
  }, [client]);

  // Reconcile every render so changes to pieces / liveIds reach the sim
  // without waiting for the next frame.
  useEffect(() => {
    const hardware = hardwareRef.current;
    if (hardware === null) return;
    hardware.syncLayout(pieces);
    hardware.syncLive(pieces, liveIds);
    // Power reconciliation runs AFTER syncLive so a newly-spawned train exists
    // before we (possibly) set it inert. syncLive never touches power; this is
    // the sole power path.
    hardware.syncPower(pieces, poweredOffIds);
  }, [pieces, liveIds, poweredOffIds]);

  // RAF loop — advance the sim by real elapsed time, capped inside
  // `ToyHardware.tick` so background tabs can't fast-forward minutes.
  // After each tick we call `onTick` (if provided) so that the carriage-
  // position driver can schedule a React state bump without introducing a
  // second timer.
  useEffect(() => {
    let lastMs = performance.now();
    let rafHandle: number | null = null;
    const step = (nowMs: number): void => {
      const dt = nowMs - lastMs;
      lastMs = nowMs;
      hardwareRef.current?.tick(dt);
      onTickRef.current?.();
      rafHandle = requestAnimationFrame(step);
    };
    rafHandle = requestAnimationFrame(step);
    return () => {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    };
  }, []);

  return { hardwareRef };
}
