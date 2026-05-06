# ADR-003: MQTT for application transport

## Status

Accepted.

## Context

The platform needs an application-layer transport for device events and commands. Options:

1. **WebSocket direct to server.** Simple, no broker infrastructure, but the server has to fan out events to all consumers (visualiser, scheduler, future audit/debug tools), and adding a new consumer means changing the server.

2. **MQTT with a broker.** Pub/sub model. Devices publish events to topics; consumers subscribe. The broker handles fan-out. Adds Mosquitto as infrastructure but otherwise simpler.

3. **gRPC, REST.** Request/response patterns don't fit an event-driven model where many consumers care about every event.

## Decision

MQTT (3.1.1 or 5) is the application-layer transport. A broker (Mosquitto in development) runs alongside the server. The server is itself an MQTT client subscribing to events.

Topic structure:
```
railway/events/{event_type}/{device_id}                  # events from devices
railway/events/custom/{vendor}/{event_type}/{device_id}  # satellite events
railway/commands/{device_id}                             # commands to a specific device
railway/state/{entity_type}/{entity_id}                  # retained state messages
```

QoS 1 for events and commands. JSON payloads. Per-device credentials.

## Consequences

- The visualiser becomes trivial: subscribe to `railway/events/#`, render events as they arrive. Same for any future consumer.
- Retained messages on `railway/state/#` give new subscribers the current snapshot for free. No "fetch initial state" RPC needed.
- The broker is infrastructure. Mosquitto in Docker for development; production deployment needs a broker too. Acceptable.
- Battery-powered devices can publish-and-sleep with QoS 1. WiFi sleep penalties are real but workable for v1.
- The application protocol is independent of physical transport. Devices on ESP-NOW connect via a bridge that re-publishes their messages on MQTT. The bridge is the only thing that knows about ESP-NOW; everything above sees a uniform MQTT view.
- We commit to JSON for v1. CBOR may come later as a wire optimisation transparent to the application protocol.
