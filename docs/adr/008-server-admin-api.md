# ADR-008: HTTP admin API on the server

## Status

Accepted

## Context

The scheduler has run-time entry points the wire protocol doesn't reach: assigning a route, revoking a clearance, forcing a gate state, binding a tag from an operator's hand. Today these only exist as direct method calls on the `Server` object (`server.assignRoute(...)`). That works for the in-process integration tests and the simulator-ui's "spawn train" button (which holds its own scheduler in embedded mode), but it leaves no path for:

- A remote operator UI on a different host driving a single deployed server.
- A `curl` against a running deployment to assign a demo route during a Pi setup.
- The visualiser doing meaningful actions once the simulator-ui is no longer the de facto scheduler (per the device-only mode work in ADR-007 follow-ups).

The protocol spec (`docs/spec/protocol-v0.2.md`) lists this as an open question for v0.3, with two candidate shapes: MQTT request/response (via MQTT 5 properties or a custom topic convention) and a separate HTTP endpoint. ADR-003 already accepted that the application protocol stays on MQTT; this ADR scopes operations *adjacent* to that protocol.

## Decision

The server exposes an HTTP API on a configurable port (default 3000). It is a thin operator surface — every endpoint maps to a single scheduler method or to publishing a single command on MQTT. The application protocol stays on MQTT exactly as before; HTTP is only for the operator's request/response interactions that don't fit a pub/sub event model.

### Why HTTP and not MQTT 5 / control topics

- **Tooling parity.** Anything that speaks HTTP can drive the server: a Bash script, a Pi setup tool, the visualiser, future iOS/Android remotes. MQTT-as-control-channel works but forces every client to ship an MQTT library and learn the topic conventions.
- **Request/response is what HTTP is for.** "Assign this route and tell me whether it was accepted" is a synchronous request with a single response. MQTT 5 has request/response semantics, but aedes (our test broker) doesn't speak v5 (see ADR-007 follow-ups), and the simulator-ui's `mqtt` client is on v3.1.1 today.
- **Clean separation of concerns.** Devices speak MQTT; operators speak HTTP. The split keeps the broker side simple (it doesn't need to be the operator's command bus).

### Endpoint shape (v0.1)

JSON in, JSON out. `Content-Type: application/json` required on POSTs.

- `GET /api/health` → `{ status: "ok", layout_name }`
- `GET /api/state` → snapshot of the scheduler view: layout, registered devices, train states, current tag bindings. Read-only; useful for debugging and for the operator UI's first-paint.
- `POST /api/trains/:train_id/route` body `{ route_id, edges }` → assigns a route. Returns `204 No Content` on success, `404` if train not registered, `400` on payload validation failure.
- `POST /api/trains/:train_id/revoke_clearance` body `{ reason, immediate }` → publishes the `revoke_clearance` command. `204` on dispatched.
- `POST /api/gates/:device_id/hold` body `{ marker_id, reason? }` → publishes `hold_gate`. `204`.
- `POST /api/gates/:device_id/release` body `{ marker_id }` → publishes `release_gate`. `204`.
- `POST /api/tags` body `{ tag_id, assigned_kind, target_id, marker_kind?, metadata? }` → publishes a `tag_assignment` event as a synthetic `ADMIN-API` device that declares `core.assigns_tags`. `204`.

The `ADMIN-API` device is registered automatically when the HTTP server starts. It's the only device the HTTP layer impersonates; everything else routes through pre-existing scheduler entry points.

### Implementation choices

- **Node `node:http` module, no framework.** A handful of endpoints don't justify Express. ~80 LoC for the router + handlers, similar to what `MqttBrokerClient` already weighs.
- **Boot lifecycle.** Server gains `startHttp(port)` and `stopHttp()`. The CLI grows a `--http-port` flag (default 3000, `--http-port 0` disables).
- **Auth.** None in v0.1. Per spec, "good enough for a home toy" — the API is intended for `127.0.0.1` and LAN. The README will document binding to a private interface for any non-home deploy.
- **Errors.** JSON envelope `{ error: string, code: 'validation' | 'not_found' | 'internal' }`. Validation through TypeBox using the schemas already declared in `@trainframe/protocol`.
- **CORS.** Permissive (`Access-Control-Allow-Origin: *`) for the visualiser running on a different origin during development. Tighten in v0.2 once we have a story for hosted deployments.

### What this does not cover

- **Server-to-operator notifications.** The visualiser already subscribes to retained state + events over MQTT. The HTTP API only handles operator-initiated actions; reactions still arrive over the broker.
- **Long-running operations.** Everything is request/response. If a future "plan a route from A to B" call needs progress reporting, route the in-progress events through MQTT and only return the route ID via HTTP.
- **Pagination / large state.** `GET /api/state` returns the full snapshot. Layouts large enough to make this painful are far away.
- **Auth.** Deferred to a later ADR pairing it with TLS + per-device credentials.

## Consequences

- A second transport on the server (port + HTTP server) to maintain. Small surface, easily testable.
- The visualiser and simulator-ui can issue operator actions without exporting brittle MQTT topic conventions to every UI button.
- Integration tests gain a `fetch()` path against the running server; we can assert on response codes and HTTP-side error handling without round-tripping through MQTT.
- ADR-008 supersedes the open-question paragraph in `docs/spec/protocol-v0.2.md`: HTTP is the operator API, MQTT remains the application protocol.
