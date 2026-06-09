# ADR-020: HTTP query API split (read-only queries vs. the admin command API)

## Status

Accepted — implemented (June 2026). Read-only `GET /api/query/*` family
(layout, traversal-times, trains(/:id), clearances, tags) added in
`packages/server` as thin projections of existing Scheduler/LayoutState
accessors; `/api/state` retained as a deprecated alias. No protocol bump —
HTTP query is a synchronous read/tooling channel, MQTT stays the application
transport. Route planning deliberately deferred to a future planner ADR.

Builds on [ADR-003](003-mqtt-transport.md) (MQTT is the application transport)
and [ADR-008](008-server-admin-api.md) (the server's HTTP admin API for
operator-initiated, mutating actions). Resolves the query-API open question
carried in `docs/spec/protocol-v0.2.md`.

## Context

`docs/spec/protocol-v0.2.md`, under "Open questions for v0.3", still flags this
as undecided:

> The split between MQTT pub/sub and HTTP query API is currently informal; some
> queries (current layout snapshot, route planning request) might want a
> request/reply pattern. MQTT 5 has request/response built in; whether to use it
> or a separate HTTP server is undecided.

ADR-008 settled the *command* half: operator-initiated, mutating actions
(`assign route`, `revoke clearance`, `hold`/`release gate`, `assign tag`) go
over HTTP because they are synchronous request/response and we want tooling
parity without forcing every client to ship an MQTT library. But ADR-008 left
the *read* half informal. It bolted a single catch-all `GET /api/state` onto the
admin surface "useful for debugging and for the operator UI's first-paint" and
explicitly deferred pagination and any richer query shape.

That catch-all has since become the only HTTP path to a growing set of read-only
facts the core now computes but does not expose individually:

- the logical layout graph — `LayoutState.getMarker`, `edgesFrom`,
  `getSwitchPosition` (`packages/core/src/scheduler/layout-state.ts`);
- learned per-edge traversal times and sample counts —
  `getLearnedTraversalMs`, `traversalCount` (same file), the substrate ADR-009
  discovery and ADR-010 transit planning depend on;
- current clearances and train positions — `Scheduler.getTrainState`
  (`last_marker_id`, `clearance_limit_marker_id`, `cleared_edges`, `transit`,
  `schedule`) and `getTrainIds` (`packages/core/src/scheduler/scheduler.ts`);
- tag bindings — `Scheduler.getTagRegistry().entries()`.

Today `admin-http.ts`'s `state()` hand-rolls one fixed projection of a subset of
these. There is no way to fetch just the layout graph, or just the learned
traversal times, without pulling (and the server re-serialising) the whole blob.
Tooling that wants read-only access — a Pi setup script inspecting learned
times, a "show me the graph" debug view, a remote operator UI's first paint —
must either parse the omnibus `/api/state` or subscribe to MQTT and reconstruct
state from retained topics. Reconstruct-from-retained is the right model for a
*live* subscriber (the visualiser already does it), but it is the wrong tool for
a one-shot synchronous "what is the layout graph right now?" question from a
script or a cold-starting UI.

The conceptual mismatch mirrors ADR-008's own framing — "devices speak MQTT;
operators speak HTTP" — but applied to the read/write axis instead of the
device/operator axis. Reads and writes have been conflated under one `/api`
namespace where they have genuinely different shapes: writes are commands with
side effects and a synthetic `ADMIN-API` device identity; reads are pure
projections of scheduler state with no identity and no effect. Leaving the read
side as one undifferentiated `/api/state` blob is the "informal split" the spec
calls out, still unresolved.

## Decision

Split the server's HTTP surface into two explicit, co-located families:

1. A **read-only query API** under `GET /api/query/*`: a resource-oriented set of
   endpoints that project scheduler/layout state. No side effects, no device
   impersonation, safe to call repeatedly and to cache. This *resolves* the
   spec's open question in favour of HTTP-for-reads, not MQTT 5 request/response.
2. The **admin command API** of ADR-008 (`POST /api/trains/...`,
   `/api/gates/...`, `/api/tags`) stays exactly as it is: the mutating,
   operator-initiated half.

Both live **only in `packages/server`** (`admin-http.ts`, or a sibling
`query-http.ts` it composes). The query handlers read through the existing
public accessors on `Scheduler` and `LayoutState` — they add no new logic and no
new state; per CLAUDE.md, query *projection shaping* is composition/IO and
belongs in the server, never in `core` or `protocol`. The existing omnibus
`GET /api/state` is retained as a deprecated convenience alias (it is what the
visualiser/sim-ui first-paint use today) and slated for removal once callers
move to the granular query endpoints.

### MQTT remains the application transport

This is a synchronous read/tooling channel, **not** a new application transport.
Per ADR-003 the application protocol stays on MQTT: devices announce, observe,
and receive clearance over the broker, and live subscribers (the visualiser)
keep reconstructing state from retained topics and the event stream. The HTTP
query API exists for the request/reply questions that pub/sub answers awkwardly
— "give me the whole layout graph once", "what are the learned traversal times
right now", "what is this train's current clearance" — issued by scripts, debug
tooling, and cold-starting UIs. It is a read-through view onto the same state the
broker already carries, never a second channel devices or the scheduler push
through. No protocol version bump: nothing on the wire changes.

### Why HTTP query and not MQTT 5 request/response

The same reasoning ADR-008 gave for commands applies, and more sharply, to reads:

- **Tooling parity.** `curl http://server/api/query/layout` works from any shell,
  Pi setup tool, or browser fetch. MQTT 5 request/response forces every reader
  to ship an MQTT v5 client and learn a correlation-data/response-topic
  convention for a question that is fundamentally "GET this resource".
- **aedes still doesn't speak v5.** Our in-process test broker (ADR-007
  follow-ups) and the sim-ui's `mqtt` v3.1.1 client cannot do v5
  request/response, so an MQTT-query path could not be exercised through the
  real seams the way CLAUDE.md's integration-test philosophy requires. An HTTP
  endpoint is testable with a plain `fetch()` against the running server.
- **Caching and idempotency for free.** Read-only GETs are safe to retry, cache,
  and proxy. HTTP's verbs already encode "this is a pure read"; a custom MQTT
  topic convention would re-invent that contract informally.

### Why a separate `/api/query/*` namespace and not just more fields on `/api/state`

- **Granularity.** Callers fetch only what they need — the layout graph without
  train churn, or learned times without the tag table — instead of the server
  re-serialising the whole world on every poll.
- **Read/write separation is legible in the URL.** `GET /api/query/*` is
  visibly side-effect-free; `POST /api/trains/...` is visibly mutating. Auth,
  CORS, rate-limiting, and caching policy can later differ per family without
  untangling them (ADR-008 deferred auth; this split is what lets a future auth
  ADR grant read-only tokens without command rights).
- **Room to evolve each half independently.** Pagination, filtering, and
  ETags — all deferred by ADR-008 for `/api/state` — can land on the query
  family without touching command semantics.

### Endpoint shape (v0.1 of the query API)

JSON out, `Content-Type: application/json`, read-only (GET), no body. Same error
envelope as ADR-008 (`{ error, code }`). All projections are of state the
scheduler/layout already hold.

- `GET /api/query/layout` → the logical graph: markers (id, kind, switch
  position where applicable) and edges (`from_marker_id`, `to_marker_id`,
  `requires_switch_state`, declared vs. learned flag per ADR-009). The
  scheduler's view, not the spatial layout.
- `GET /api/query/traversal-times` → learned per-edge traversal estimates and
  sample counts (`getLearnedTraversalMs`, `traversalCount`), optionally
  `?train_id=` for the per-train estimate (ADR-010). The data discovery and
  transit planning consume; surfacing it makes learning legible to tooling.
- `GET /api/query/trains` → all train states: `last_marker_id`,
  `clearance_limit_marker_id`, `cleared_edges`, `transit`, `schedule`.
- `GET /api/query/trains/:train_id` → one train's state, `404` if unknown.
- `GET /api/query/clearances` → the current clearance picture derived from
  train states (which edges each train holds, each train's clearance limit) —
  the read counterpart to the `grant`/`revoke` commands, so an operator can ask
  "who holds what" without inferring it from the event stream.
- `GET /api/query/tags` → current tag bindings (`getTagRegistry().entries()`).

Spatial layout (the visualiser's `x_mm`/`y_mm` coordinates, ADR-013) is **not**
part of this API: per the spatial/logical separation commitment it is the
sim-ui/visualiser's concern and already travels its own path. The query API
serves the *logical* graph and scheduler state only. If a synchronous spatial
snapshot is ever wanted, it is a flagged follow-up, not a silent addition here.

### Implementation choices

- **Same `node:http`, no framework** as ADR-008. The query routes are added to
  the existing router (or a `query-http.ts` the `AdminHttpServer` mounts),
  sharing the CORS, JSON, and error helpers already in `admin-http.ts`.
- **No new core surface.** Handlers call the existing public accessors. If a
  projection needs a fact not yet exposed, the fix is a public observer method
  on `Scheduler`/`LayoutState` (per CLAUDE.md's test-observability guidance),
  never reaching into private fields and never new logic in the server.
- **Same boot lifecycle and port** as the admin API (ADR-008's `startHttp` /
  `--http-port`); one HTTP server hosts both families.

## Consequences

- The spec's "Open questions for v0.3" query-API item is resolved: HTTP for
  synchronous reads, MQTT unchanged as the application transport. A v0.3 spec
  edit should record that ADR-020 supersedes that paragraph, the way ADR-008
  superseded the command half — no protocol version bump, since nothing on the
  wire changes.
- Tooling and cold-starting UIs gain granular, cacheable read access without an
  MQTT client; integration tests assert on query responses via `fetch()`
  through the real running server, consistent with the testing philosophy.
- A second endpoint family to maintain, but it shares the ADR-008 router and
  adds no logic — handlers are thin projections. `GET /api/state` lingers as a
  deprecated alias until callers migrate, then is removed.
- The read/write split lays the groundwork for a future auth ADR to scope
  read-only credentials separately from command credentials (ADR-008 deferred
  auth entirely; this makes the eventual grant model cleaner).

### Deferred follow-ups

- **Auth.** Still none, per ADR-008. The query/command split is the seam a later
  TLS + credentials ADR will cut along (read tokens vs. command tokens).
- **Pagination / filtering / ETags** on the query family — unnecessary at home-
  layout sizes, easy to add to `/api/query/*` later without touching commands.
- **Route-planning request/reply** (`plan a route from A to B`) — the spec pairs
  this with the query question, but planning is a *computation that may emit
  in-progress events*; ADR-008 already said such long-running operations route
  progress over MQTT and return only an id via HTTP. Whether the *request* lands
  as `POST /api/query/plan` (pure, returns a candidate plan) or as a command is
  left to the planner ADR; it is not decided here.
- **Synchronous spatial snapshot** over HTTP, if ever wanted, is a separate
  flagged decision (keeps the spatial/logical separation intact).
- **Removal of the `/api/state` alias** once the visualiser and sim-ui first
  paint move to the granular endpoints.
