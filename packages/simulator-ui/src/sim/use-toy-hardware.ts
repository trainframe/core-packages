import { useEffect, useRef } from 'react';
import type { BrokerClient } from '../broker/client.js';
import type { TrackPiece } from '../track/pieces.js';
import { ToyHardware } from './toy-hardware.js';

interface UseToyHardwareArgs {
  readonly pieces: ReadonlyArray<TrackPiece>;
  readonly liveIds: ReadonlySet<string>;
  readonly client: BrokerClient;
}

/**
 * Drives a `ToyHardware` instance from inside `ToyTable`. The hook owns the
 * `requestAnimationFrame` loop that advances the physics simulation, and
 * keeps the simulation in sync with whatever the operator is doing on the
 * canvas (placing pieces, scanning trains, powering devices off).
 *
 * Exposes nothing — the broker is the system source of truth, so callers
 * observe sim output by subscribing to MQTT topics like everyone else.
 */
export function useToyHardware({ pieces, liveIds, client }: UseToyHardwareArgs): void {
  const hardwareRef = useRef<ToyHardware | null>(null);

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
  }, [pieces, liveIds]);

  // RAF loop — advance the sim by real elapsed time, capped inside
  // `ToyHardware.tick` so background tabs can't fast-forward minutes.
  useEffect(() => {
    let lastMs = performance.now();
    let rafHandle: number | null = null;
    const step = (nowMs: number): void => {
      const dt = nowMs - lastMs;
      lastMs = nowMs;
      hardwareRef.current?.tick(dt);
      rafHandle = requestAnimationFrame(step);
    };
    rafHandle = requestAnimationFrame(step);
    return () => {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    };
  }, []);
}
