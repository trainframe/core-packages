import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * Loose layout shape — see `@trainframe/protocol`'s `Layout` schema for the
 * authoritative version. We parse defensively here because the visualiser is
 * a downstream subscriber: malformed data shouldn't crash the page.
 */
export interface VisualiserLayout {
  readonly name: string;
  readonly markers: ReadonlyArray<VisualiserMarker>;
  readonly edges: ReadonlyArray<VisualiserEdge>;
}

export interface VisualiserMarker {
  readonly id: string;
  readonly kind: string;
  readonly position?: { readonly x_mm: number; readonly y_mm: number };
  readonly label?: string;
}

export interface VisualiserEdge {
  readonly from_marker_id: string;
  readonly to_marker_id: string;
  readonly estimated_length_mm?: number;
}

/**
 * Subscribe to `railway/state/layout/+` and return the most recent layout
 * received. Returns `null` while no layout has arrived (typical on first
 * connection before any retained message is replayed).
 */
export function useLayoutState(): VisualiserLayout | null {
  const { client } = useBroker();
  const [layout, setLayout] = useState<VisualiserLayout | null>(null);

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseLayoutMessage(message.payload);
      if (parsed) setLayout(parsed);
    };
    return client.subscribe('railway/state/layout/+', handler);
  }, [client]);

  return layout;
}

function parseLayoutMessage(payload: Uint8Array): VisualiserLayout | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isLayoutShape(raw)) return null;
  return raw;
}

function isLayoutShape(value: unknown): value is VisualiserLayout {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== 'string') return false;
  if (!Array.isArray(obj.markers)) return false;
  if (!Array.isArray(obj.edges)) return false;
  return obj.markers.every(isMarker) && obj.edges.every(isEdge);
}

function isMarker(value: unknown): value is VisualiserMarker {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.id === 'string' && typeof m.kind === 'string';
}

function isEdge(value: unknown): value is VisualiserEdge {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.from_marker_id !== 'string' || typeof e.to_marker_id !== 'string') return false;
  if (e.estimated_length_mm !== undefined && typeof e.estimated_length_mm !== 'number') {
    return false;
  }
  return true;
}
