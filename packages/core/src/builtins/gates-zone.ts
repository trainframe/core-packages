import { type Static, Type } from '@sinclair/typebox';
import type { Capability } from '../capability.js';

/**
 * The gates_zone capability lets a device own a capacity-limited territory (a
 * "zone" — e.g. a railyard) and gate admission to it by its OWN asserted
 * occupancy. See ADR-026.
 *
 * The zone presents to the core graph as a single boundary marker
 * (`zone_marker_id`, the throat). Routing a train into the zone means extending
 * its clearance to that marker; this capability vetoes that extension while the
 * zone is full. A denied train holds at the throat and is admitted
 * automatically once the device emits a lower occupancy (the scheduler's
 * existing deny-and-hold / retry machinery — identical to gates_clearance).
 *
 * The crucial difference from gates_clearance: "full" is the DEVICE'S judgment,
 * not core's. A slot can be locked by a cut of carriages with no locomotive, and
 * carriages are invisible to core (ADR-016) — so core has no oracle for
 * occupancy and trusts the asserted count exactly as it trusts a length
 * (ADR-023) or a tag binding (ADR-007). The capability gate is the trust
 * boundary; there is no value validation beyond the protocol's structural
 * schema (non-negative integers).
 *
 * State per device: the zones it owns, keyed by boundary marker, each with its
 * last-asserted capacity and occupancy.
 */

const GatesZoneState = Type.Object({
  zones: Type.Array(
    Type.Object({
      zone_marker_id: Type.String(),
      capacity: Type.Integer({ minimum: 0 }),
      occupancy: Type.Integer({ minimum: 0 }),
    }),
  ),
});

type State = Static<typeof GatesZoneState>;

export const gatesZoneCapability: Capability<State> = {
  id: 'core.gates_zone',
  description:
    'A device that owns a capacity-limited zone (e.g. a railyard) and gates ' +
    'admission to it by its own asserted occupancy. The zone appears in the core ' +
    'graph as one boundary marker; the device denies entry while full.',

  customEvents: [], // uses the core zone_state_changed event
  customCommands: [],

  stateSchema: GatesZoneState,

  initialState: () => ({ zones: [] }),

  hooks: {
    onEvent: (state, ctx) => {
      if (ctx.event_type !== 'zone_state_changed') {
        return { newState: state, intents: [] };
      }

      // Shape guaranteed by the protocol schema at the broker boundary.
      const payload = ctx.payload as {
        zone_marker_id: string;
        capacity: number;
        occupancy: number;
      };

      const others = state.zones.filter((z) => z.zone_marker_id !== payload.zone_marker_id);
      return {
        newState: {
          zones: [
            ...others,
            {
              zone_marker_id: payload.zone_marker_id,
              capacity: payload.capacity,
              occupancy: payload.occupancy,
            },
          ],
        },
        intents: [],
      };
    },

    onClearanceConsultation: (state, request) => {
      // Deny entry to a zone whose boundary marker is the proposed new limit,
      // while the device reports it full. Otherwise abstain.
      const zone = state.zones.find(
        (z) => z.zone_marker_id === request.proposed_new_limit_marker_id,
      );
      if (zone && zone.occupancy >= zone.capacity) {
        return {
          vote: 'deny',
          reason: `zone full: ${zone.occupancy}/${zone.capacity} slots occupied`,
        };
      }
      return { vote: 'abstain' };
    },

    onDeviceDisconnect: (_state) => {
      // A vanished zone owner stops gating: clear its zones so it can't hold
      // trains hostage at the throat. Mirrors gates_clearance — a device that
      // disappeared while denying is a worse failure than a brief unintended
      // admission, and with no owner there is no interior authority to maneuver
      // an admitted train anyway (it simply waits at the boundary).
      return {
        newState: { zones: [] },
        intents: [
          {
            kind: 'emit_anomaly',
            severity: 'warning',
            description: 'gates_zone device disconnected; dropping its admission gate',
          },
        ],
      };
    },
  },
};
