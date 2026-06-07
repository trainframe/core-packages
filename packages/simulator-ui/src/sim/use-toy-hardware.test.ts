import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import type { RotationDeg, TrackPiece } from '../track/pieces.js';
import { useToyHardware } from './use-toy-hardware.js';

let nextId = 0;
function pid(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function piece(type: TrackPiece['type'], x = 0, y = 0, rotationDeg: RotationDeg = 0): TrackPiece {
  return { id: pid(type), type, position: { x, y }, rotationDeg, tagged: false };
}

describe('useToyHardware', () => {
  it('publishes device_registered when a train piece flips live', () => {
    nextId = 0;
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const s1 = piece('straight', 100, 100);
    const s2 = piece('straight', 300, 100);
    const train = piece('train', 110, 100);
    const startProps = {
      pieces: [s1, s2, train] as ReadonlyArray<TrackPiece>,
      liveIds: new Set<string>(),
      poweredOffIds: new Set<string>(),
      client,
    };
    const { rerender, unmount } = renderHook((props: typeof startProps) => useToyHardware(props), {
      initialProps: startProps,
    });
    try {
      act(() => {
        rerender({ ...startProps, liveIds: new Set([train.id]) });
      });
      const topic = `railway/events/device_registered/T-${train.id}`;
      expect(client.published.find((m) => m.topic === topic)).toBeDefined();
    } finally {
      unmount();
    }
  });
});
