/**
 * MQTT topic structure for the Trainframe protocol.
 *
 * Conventions:
 *   railway/events/{event_type}/{device_id}    — events from devices
 *   railway/events/custom/{vendor}/{event_type}/{device_id}
 *                                              — custom events from satellite devices
 *   railway/commands/{device_id}               — commands to a specific device
 *   railway/state/{entity_type}/{entity_id}    — retained state messages
 *   railway/discovery/register                 — device registration handshake
 *
 * All topic construction must go through this module to avoid typos.
 */

export const topics = {
  event: (eventType: string, deviceId: string): string => `railway/events/${eventType}/${deviceId}`,

  customEvent: (vendor: string, eventType: string, deviceId: string): string =>
    `railway/events/custom/${vendor}/${eventType}/${deviceId}`,

  command: (deviceId: string): string => `railway/commands/${deviceId}`,

  state: (entityType: string, entityId: string): string =>
    `railway/state/${entityType}/${entityId}`,

  registration: 'railway/discovery/register',
} as const;

export const subscriptions = {
  /** All events. The visualiser uses this. */
  allEvents: 'railway/events/#',

  /** Core events only (excludes custom/...). The scheduler uses this. */
  coreEvents: 'railway/events/+/+',

  /** Custom events from a specific vendor. */
  customEventsForVendor: (vendor: string): string => `railway/events/custom/${vendor}/#`,

  /** All events of a specific type, regardless of device. */
  eventsOfType: (eventType: string): string => `railway/events/${eventType}/+`,

  /** Commands to a specific device (the device subscribes to its own). */
  commandsForDevice: (deviceId: string): string => `railway/commands/${deviceId}`,

  /** All commands. Useful for audit/debugging. */
  allCommands: 'railway/commands/#',

  /** All retained state. The visualiser subscribes for current snapshot. */
  allState: 'railway/state/#',
} as const;

/**
 * Parse an event topic to extract its components.
 * Returns null for malformed topics.
 */
export function parseEventTopic(
  topic: string,
):
  | { kind: 'core'; event_type: string; device_id: string }
  | { kind: 'custom'; vendor: string; event_type: string; device_id: string }
  | null {
  const parts = topic.split('/');
  const [head, kind, third, fourth, fifth, sixth] = parts;
  if (head !== 'railway' || kind !== 'events') return null;

  if (third === 'custom') {
    if (parts.length !== 6 || !fourth || !fifth || !sixth) return null;
    return { kind: 'custom', vendor: fourth, event_type: fifth, device_id: sixth };
  }

  if (parts.length !== 4 || !third || !fourth) return null;
  return { kind: 'core', event_type: third, device_id: fourth };
}
