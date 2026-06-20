# State lifecycle management

Date: 2026-06-20
Status: approved design, pending implementation plan

## Problem

The visualiser keeps "remembering" trains and track pieces that no longer
exist: dead trains show as *registered, position unknown, no schedule*, and
markers from old layouts linger as disconnected dots with `0 in / 0 out`
edges. There is no operator action anywhere to clear them — the visualiser is
a read-only projection with a single write action (assign route).

### Root cause

The ghosts are not in the visualiser. The visualiser is a pure read-only
projection of MQTT. The state lives in two places:

1. The server's in-memory scheduler maps (`trains`, `devices`,
   `LayoutState`).
2. **Retained MQTT messages on the broker** — `railway/state/devices/<id>`,
   `schedule/<id>`, `clearance/<id>`, `layout/<name>`, etc. These survive
   broker restarts and are replayed to every new subscriber.

When a train disconnects (`device_disconnected`), the server clears the
train's retained `schedule` and `clearance` topics and drops it from the
scheduler maps — **but it never clears the retained
`railway/state/devices/<id>` topic.** That announcement lives on the broker
forever, so every reconnect resurrects the dead train. This is a genuine bug,
and it is the source of the accumulated mess.

Critically: if the server has restarted since a train disconnected, its
in-memory maps are *empty* while the broker still holds the retained ghost.
Any cleanup that only touches the server's maps does nothing for the ghosts
that matter most.

## Goals

- A **blank slate** action: wipe all trains, devices, and layout back to
  empty — server memory *and* broker-retained state.
- A **prune** action: remove orphaned markers (zero-edge) and republish the
  layout.
- **Delete a train from memory**: forget a single train entirely so it must
  re-register before it can be used again (distinct from merely stopping it).
- A cleaner train-management UI/UX in the visualiser, with per-train cards and
  clear actions.
- Fix the underlying retained-`devices` leak so future disconnects self-clean.

## Non-goals

- Reaching into the simulator-ui's local toy state. Blank slate clears
  server + broker. If live toys remain in the sim-ui they will re-announce;
  that is expected and out of scope.
- New transport or message-format changes. We reuse existing topic shapes;
  the only protocol-doc addition is clarifying the deregister tombstone.
- Reachability-based or "idle siding" marker pruning. Prune removes
  zero-edge markers only (see Decisions).

## Core principle

Every destructive operation clears **broker-retained state directly**, not
just the server's in-memory maps. The ghosts survive precisely because they
live as retained MQTT messages independent of the server's memory: a restarted
server has empty maps while the broker still replays the ghosts. So the server
cannot enumerate what to clear from its own state — it must learn it from the
broker.

**Retained-topic ledger.** On `start()` the server subscribes to
`railway/state/#`. The broker replays every retained state message — including
ghosts published by a previous server instance or by the simulator — so the
server accumulates a live `Set<string>` of retained state topics. Reset
iterates that set.

**Per-family tombstones (there is no universal tombstone).** Investigation of
the visualiser consumers showed each state family recognises its *own* "empty"
shape, and several ignore a zero-length payload outright. To tombstone a topic
the server publishes the recognised-empty payload for that family, retained:

| Topic family | Recognised-empty (tombstone) payload | Consumer behaviour on it |
| --- | --- | --- |
| `railway/state/devices/<id>` | `{}` (object lacking `capabilities`) | removed from roster |
| `railway/state/schedule/<id>` | `{ "train_id": "<id>" }` (no `stops`) | schedule row removed |
| `railway/state/clearance/<id>` | `{ "train_id": "<id>", "cleared_edges": [] }` | all that train's edges released |
| `railway/state/layout/<name>` | `{ "name": "<name>", "markers": [], "edges": [], "junctions": [] }` | empty layout (zero-length is **ignored**) |
| `railway/state/deadlock/active` | `{ "trains": [] }` | banner cleared |
| `railway/state/track_learning/active` | learn-mode idle snapshot | idle (zero-length is **ignored**) |

These all route through the existing `effects.updateState(entity_type,
entity_id, state)` → `railway/state/<entity_type>/<entity_id>` retained-publish
path, so no new broker primitive or effect kind is needed. (Note: the
recognised-empty JSON is retained, not deleted, on a real broker — harmless
cruft that every consumer reads as "gone". True zero-length deletion is
avoided because the layout and track-learning consumers ignore it.)

## Design

### Server: `packages/server/src/admin-http.ts` + scheduler

Three new endpoints plus one bug fix. All destructive HTTP ops go through the
admin API (not MQTT operator topics) because they must clear retained state,
which the server centralises.

- **`DELETE /api/trains/:id`** — delete from memory.
  Removes the device + train from the scheduler maps and tombstones retained
  `railway/state/devices/:id`, `schedule/:id`, `clearance/:id`.
  Response: `200` with a summary of what was cleared, or `404` if unknown.

- **`POST /api/maintenance/prune-markers`** — remove orphaned markers.
  Removes every marker with zero incoming and zero outgoing edges from
  `LayoutState`, then republishes the layout retained.
  Response: `200` with `{ pruned: string[] }`.

- **`POST /api/maintenance/reset`** — blank slate.
  Enumerates all retained `railway/state/#` topics and tombstones each;
  clears the scheduler `trains` and `devices` maps and `LayoutState`;
  republishes an empty layout, empty deadlock set, and empty track-learning
  state so subscribers converge on a clean slate.
  Response: `200` with a summary count of topics cleared.

- **Bug fix:** `handleDeviceDisconnect` also tombstones retained
  `railway/state/devices/:id` (with `{}`). This stops future disconnects from
  leaking the ghost that caused this problem.

`DELETE /api/trains/:id` and the disconnect handler share a single
`forgetDevice(id)` scheduler method so the two code paths cannot drift in what
"forget a device" means.

#### New supporting methods (no new effect kinds)

- **`LayoutState.pruneOrphanMarkers(): string[]`** — removes every marker with
  no incident edges (and its entries in the aux maps: `outgoingEdges`,
  `incomingEdges`, `traversalCounts`, `switchPositions`,
  `junctionsByMarkerId`, `switchDeviceByMarker`), returning the removed ids.
  `LayoutState` currently has only `upsertMarker` — no removal exists.
- **`LayoutState.reset(): void`** — reverts the live graph to its
  constructed-from-options baseline (in discovery mode this is empty). Stores
  the constructor `layout`/`options` so it can rebuild the internal maps.
- **`Scheduler.forgetDevice(deviceId): SchedulerEffect[]`** — the shared
  removal: runs capability `onDeviceDisconnect`, deletes from `devices` and
  (if a train) `trains`, emits the devices/schedule/clearance tombstones, and
  retries blocked clearances. `handleDeviceDisconnect` and the `DELETE`
  endpoint both call it.
- **`Scheduler.reset(): void`** — clears `trains`, `devices`, and calls
  `layout.reset()`. Pure in-memory; the server handles the broker side.
- **Server `retainedStateTopics: Set<string>`** — populated by a
  `railway/state/#` subscription added in `start()`. `server.reset()` calls
  `scheduler.reset()`, then for each topic in the set publishes the per-family
  tombstone from the table above (deriving the family from the topic's third
  segment), and finally republishes the layout/deadlock/track-learning
  baselines via the existing `publish*State` helpers. Synchronous — no async
  drain needed, because the ledger is maintained continuously from boot.
- **`Server.deleteTrain(id)` / `Server.pruneOrphanMarkers()` / `Server.reset()`**
  — thin server methods that invoke the scheduler/layout mutations above and
  `dispatchEffects` the results (prune dispatches
  `updateState('layout', name, toLayout())`, the same effect the scheduler
  already uses to publish the inferred layout).

### Visualiser

- **`DevicesPanel` → per-train cards.** Replace the read-only flat train list
  with a per-train card showing ID, status, position, and current route, each
  with actions:
  - **Assign route** — existing `assign_schedule` flow, surfaced per card.
  - **Stop** — wire up the already-existing
    `POST /api/trains/:id/revoke_clearance` endpoint (no UI today).
  - **Delete from memory** — new `DELETE /api/trains/:id`.

- **Maintenance strip.** A visually distinct "danger zone" near the device
  list with **Prune orphaned markers** and **Blank slate**. Blank slate
  requires an explicit typed confirmation; prune and per-train delete require
  a single-click confirm.

- **Shared admin-API client.** Add one small typed `adminApiClient` module
  built on the existing `adminApiUrl` config (`localStorage`
  `trainframe.visualiser.adminApiUrl`, default `http://127.0.0.1:3000`).
  Migrate the existing ad-hoc `fetch` in `UnknownTags` onto it and route all
  new calls through it, rather than scattering more bare `fetch` calls.

### Data flow

```
Operator clicks action in visualiser
  -> adminApiClient POSTs/DELETEs to server admin HTTP API
    -> scheduler mutates in-memory state (forgetDevice / prune / reset)
    -> server publishes empty retained payloads to tombstone broker state
      -> visualiser's MQTT subscriptions observe the tombstones and drop the
         entities from their read-only projections
```

### Error handling

- Unknown train on `DELETE` → `404`, surfaced as an inline error on the card.
- Admin API unreachable → the client surfaces the failure inline (same
  pattern as the current `UnknownTags` fetch error handling); no silent
  success.
- Prune with no orphans → `200` with `{ pruned: [] }`; UI shows "nothing to
  prune".

## Testing

Per the project testing contract — drive the system through real seams, no
mocking of scheduler/registry/broker.

- **Integration (simulator harness):** register devices through the real
  broker; simulate the restart-with-retained-ghost case; call each endpoint;
  assert the retained topics are tombstoned and that a deleted train cannot be
  routed until it re-registers. Assert prune removes only zero-edge markers
  and leaves connected ones. Assert blank slate empties everything.
- **Regression for the leak:** a test that disconnects a train and asserts
  `railway/state/devices/<id>` is tombstoned (fails before the fix).
- **UI journey (`packages/ui-tests`, Playwright):** spawn trains, delete one
  from memory, prune markers, blank-slate; assert the UI empties and the
  deleted train disappears.

## Protocol note

Add one line to the protocol spec: a retained `railway/state/devices/<id>`
payload with no `capabilities` field (e.g. `{}`) is a deregister tombstone,
matching how the visualiser's devices view already treats it. No version
bump — no shape change. (Each state family already has its own recognised
"empty" shape; see the Core principle table.)

## Decisions

- **Train-management UX:** per-train cards with explicit actions (option 2),
  with destructive maintenance in a marked danger-zone strip.
- **Orphaned marker definition:** zero-edge only (`0 in / 0 out`).
  Predictable, maps exactly to the observed mess, cannot delete a legitimate
  branch. Blank slate covers the nuke-everything case.
- **Two train verbs:** *Stop* (revoke clearance, keeps the train) vs *Delete
  from memory* (forget entirely, requires re-registration).
