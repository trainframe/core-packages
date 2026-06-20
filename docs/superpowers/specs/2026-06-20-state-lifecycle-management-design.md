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
just the server's in-memory maps. To clear retained state the server
enumerates retained topics (subscribe to the relevant `railway/state/#`
wildcard, collect what the broker replays as retained) and publishes an empty
payload to each to tombstone it. Empty-payload-as-tombstone is already the
established pattern for `schedule` and `clearance`; we extend it to
`devices/<id>` and drive it deliberately for reset.

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
  `railway/state/devices/:id`. This stops future disconnects from leaking the
  ghost that caused this problem.

`DELETE /api/trains/:id` and the disconnect handler share a single
`forgetDevice(id)` scheduler method so the two code paths cannot drift in what
"forget a device" means.

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

Add one line to the protocol spec: an empty retained payload on
`railway/state/devices/<id>` is a deregister tombstone, consistent with the
existing `schedule` and `clearance` tombstones. No version bump — no shape
change.

## Decisions

- **Train-management UX:** per-train cards with explicit actions (option 2),
  with destructive maintenance in a marked danger-zone strip.
- **Orphaned marker definition:** zero-edge only (`0 in / 0 out`).
  Predictable, maps exactly to the observed mess, cannot delete a legitimate
  branch. Blank slate covers the nuke-everything case.
- **Two train verbs:** *Stop* (revoke clearance, keeps the train) vs *Delete
  from memory* (forget entirely, requires re-registration).
