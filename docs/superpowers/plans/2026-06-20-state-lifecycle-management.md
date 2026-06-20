# State Lifecycle Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator a clean way to forget stale state — delete a train from memory, prune orphaned markers, and blank-slate the whole railway — across both the server's memory and the broker's retained messages, surfaced through a cleaner train-management UI.

**Architecture:** New destructive operations go through the server's admin HTTP API (`packages/server/src/admin-http.ts`). The server clears broker-retained state directly by maintaining a live ledger of retained `railway/state/#` topics (so it can tombstone ghosts a restarted server never knew about) and publishing each consumer's recognised-empty payload. Core gains pure mutation methods (`LayoutState.pruneOrphanMarkers`/`reset`, `Scheduler.forgetDevice`/`reset`); the server composes them and dispatches the resulting effects. The visualiser gets a shared admin-API client, per-train cards with Stop/Delete actions, and a maintenance "danger zone" strip.

**Tech Stack:** TypeScript (strict), Node `http`, MQTT (real broker via aedes in tests / Mosquitto in dev; `InMemoryBrokerClient` in unit tests), React + Vite, `@trainframe/ui-kit` (`Button`, `Panel`), Vitest + Testing Library, Playwright (`packages/ui-tests`).

## Global Constraints

- **No `any`** — not in casts, generics, or suppressions. Use the existential-wrapper pattern if variance fights you.
- **Biome clean** — `pnpm lint` zero errors/warnings. No `biome-ignore` to ship.
- **TS strictness** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. `arr[0]` is `T | undefined`; narrow, don't `!`. Clear optionals with `undefined` assignment, never `delete`.
- **No `Date.now()` / `Math.random()` in core or simulator** — use injected `now`/`SeededRandom`. (Server may use them; core/simulator may not.)
- **Capability hooks stay pure** — `(state, event) → (newState, intents)`, no I/O. Side effects live in the scheduler→effects→server path.
- **Comments** — multi-line uses `/* */` blocks, never stacked `//`. Human-length.
- **Coverage floors** (CI-enforced, never lower): protocol 90/85, core 75/75, simulator 80/75. Add tests with code.
- **Tombstone payloads are per-family** (no universal empty). Use exactly these recognised-empty shapes:
  - `railway/state/devices/<id>` → `{}`
  - `railway/state/schedule/<id>` → `{ "train_id": "<id>" }`
  - `railway/state/clearance/<id>` → `{ "train_id": "<id>", "cleared_edges": [] }`
  - `railway/state/layout/<name>` → empty layout `{ name, markers: [], edges: [], junctions: [] }`
  - `railway/state/deadlock/active` → `{ "trains": [] }`
  - `railway/state/track_learning/active` → learn-mode idle snapshot (via `learnMode.publishInitialState()`)
- **Commit style** — short subject, minimal body, NO `Co-Authored-By` trailer. Commit direct to `main` (trunk-style).

---

### Task 1: `LayoutState.pruneOrphanMarkers()`

Add a pure method that removes every marker with zero incident edges, returning the removed ids. `LayoutState` today has `upsertMarker` but no removal (`packages/core/src/scheduler/layout-state.ts:217`).

**Files:**
- Modify: `packages/core/src/scheduler/layout-state.ts`
- Test: `packages/core/src/scheduler/layout-state.test.ts`

**Interfaces:**
- Consumes: existing private maps `markers`, `outgoingEdges`, `incomingEdges`, `switchPositions`, `switchDeviceByMarker`, `junctionsByMarkerId` (all `Map`s keyed by marker id); existing `hasIncidentEdges(markerId)`, `upsertMarker(id, kind)`.
- Produces: `pruneOrphanMarkers(): string[]` — sorted ascending for determinism.

- [ ] **Step 1: Write the failing test**

Add to `layout-state.test.ts`:

```typescript
describe('LayoutState.pruneOrphanMarkers', () => {
  it('removes markers with no incident edges and returns their ids', () => {
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => 0 });
    // Add two disconnected markers (the "floating dots" case).
    layout.upsertMarker('ORPHAN-A', 'block_boundary');
    layout.upsertMarker('ORPHAN-B', 'station_stop');

    const removed = layout.pruneOrphanMarkers();

    expect(removed).toEqual(['ORPHAN-A', 'ORPHAN-B']);
    expect(layout.hasMarker('ORPHAN-A')).toBe(false);
    expect(layout.hasMarker('ORPHAN-B')).toBe(false);
    // Connected markers in the loop survive.
    expect(layout.hasMarker('M1')).toBe(true);
    expect(layout.hasMarker('M3')).toBe(true);
  });

  it('returns an empty array when every marker has edges', () => {
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => 0 });
    expect(layout.pruneOrphanMarkers()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/core test -- layout-state`
Expected: FAIL — `layout.pruneOrphanMarkers is not a function`.

- [ ] **Step 3: Implement the method**

Add to the `LayoutState` class (near `upsertMarker`):

```typescript
  /**
   * Remove every marker that has no incoming and no outgoing edges — the
   * disconnected "floating dots" left behind by deleted track. Returns the
   * removed marker ids in ascending order. Edge-keyed maps (traversalCounts,
   * learnedMs) need no cleanup: an orphan has no edges, so no key references it.
   */
  pruneOrphanMarkers(): string[] {
    const removed: string[] = [];
    for (const id of [...this.markers.keys()]) {
      const out = this.outgoingEdges.get(id)?.length ?? 0;
      const inc = this.incomingEdges.get(id)?.length ?? 0;
      if (out !== 0 || inc !== 0) continue;
      this.markers.delete(id);
      this.outgoingEdges.delete(id);
      this.incomingEdges.delete(id);
      this.switchPositions.delete(id);
      this.switchDeviceByMarker.delete(id);
      this.junctionsByMarkerId.delete(id);
      removed.push(id);
    }
    removed.sort((a, b) => a.localeCompare(b));
    return removed;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trainframe/core test -- layout-state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduler/layout-state.ts packages/core/src/scheduler/layout-state.test.ts
git commit -m "core: LayoutState.pruneOrphanMarkers removes zero-edge markers"
```

---

### Task 2: `LayoutState.reset()`

Revert the live graph to its constructed-from-options baseline. Requires extracting the constructor's graph-building into a reusable `loadFromLayout` and remembering the initial layout.

**Files:**
- Modify: `packages/core/src/scheduler/layout-state.ts`
- Test: `packages/core/src/scheduler/layout-state.test.ts`

**Interfaces:**
- Consumes: the constructor's existing body (the loop that calls `upsertMarker` and adds edges); the private maps from Task 1 plus `traversalCounts`, `learnedMs`, `learnedMsByTrain`, `lastRecordedAtByTrain`, `lastRecordedAt`.
- Produces: `reset(): void`; new private field `initialLayout: Layout`; new private `loadFromLayout(layout: Layout): void`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('LayoutState.reset', () => {
  it('reverts learned markers and edges to the constructed baseline', () => {
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => 0 });
    // Learn a brand-new marker + edge by traversal (discovery).
    layout.upsertMarker('LEARNED', 'block_boundary');
    layout.recordTraversal('M2', 'LEARNED', 'T1');
    expect(layout.hasMarker('LEARNED')).toBe(true);

    layout.reset();

    expect(layout.hasMarker('LEARNED')).toBe(false);
    expect(layout.toLayout().markers.map((m) => m.id).sort()).toEqual(['M1', 'M2', 'M3', 'M4']);
    expect(layout.toLayout().edges).toHaveLength(4);
  });

  it('reverts to an empty graph when constructed empty (discovery mode)', () => {
    const empty: Layout = { name: 'discovery', markers: [], edges: [], junctions: [] };
    const layout = new LayoutState(empty, { now: () => 0 });
    layout.upsertMarker('A', 'block_boundary');
    layout.upsertMarker('B', 'block_boundary');
    layout.reset();
    expect(layout.toLayout().markers).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/core test -- layout-state`
Expected: FAIL — `layout.reset is not a function`.

- [ ] **Step 3: Refactor the constructor and add `reset`**

In `LayoutState`, add a private field `private readonly initialLayout: Layout;`. In the constructor, store it and move the marker/edge-building block into `loadFromLayout`:

```typescript
  constructor(layout: Layout, options: LayoutStateOptions) {
    this.name = layout.name;
    this.confirmTraversals = options.confirmTraversals ?? DEFAULT_CONFIRM_TRAVERSALS;
    this.now = options.now;
    this.initialLayout = layout;
    this.loadFromLayout(layout);
  }

  /**
   * Build the graph maps from a declared layout. Used by the constructor and
   * by reset(). Validates that every edge references a known marker — the same
   * guard the constructor enforced inline before.
   */
  private loadFromLayout(layout: Layout): void {
    for (const marker of layout.markers) {
      this.markers.set(marker.id, { id: marker.id, kind: marker.kind });
      this.outgoingEdges.set(marker.id, []);
      this.incomingEdges.set(marker.id, []);
    }
    for (const edge of layout.edges) {
      if (!this.markers.has(edge.from_marker_id) || !this.markers.has(edge.to_marker_id)) {
        throw new Error(`unknown marker: ${edge.from_marker_id} -> ${edge.to_marker_id}`);
      }
      const stored: LayoutEdge = { ...edge, inferred: false };
      this.outgoingEdges.get(edge.from_marker_id)?.push(stored);
      this.incomingEdges.get(edge.to_marker_id)?.push(stored);
    }
    for (const junction of layout.junctions) {
      this.junctionsByMarkerId.set(junction.marker_id, junction);
      if (junction.initial_state !== undefined) {
        this.switchPositions.set(junction.marker_id, junction.initial_state);
      }
    }
  }

  /**
   * Revert the live graph to the layout it was constructed with, discarding
   * every learned marker, edge, switch position, and traversal statistic. In
   * discovery mode (constructed empty) this clears the graph entirely.
   */
  reset(): void {
    this.markers.clear();
    this.outgoingEdges.clear();
    this.incomingEdges.clear();
    this.switchPositions.clear();
    this.switchDeviceByMarker.clear();
    this.junctionsByMarkerId.clear();
    this.traversalCounts.clear();
    this.learnedMs.clear();
    this.learnedMsByTrain.clear();
    this.lastRecordedAtByTrain.clear();
    this.lastRecordedAt = null;
    this.loadFromLayout(this.initialLayout);
  }
```

> NOTE for implementer: the existing constructor body may differ slightly in how it shapes `LayoutEdge` / reads junctions. Preserve the existing behaviour exactly when extracting — read the current constructor first and move its logic verbatim into `loadFromLayout`, then call it from both places. The two tests above (and the pre-existing constructor "unknown marker" test) guard against regressions.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trainframe/core test -- layout-state`
Expected: PASS — including the pre-existing `throws when an edge references a marker that is not in the markers list` test (proves the extraction preserved validation).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduler/layout-state.ts packages/core/src/scheduler/layout-state.test.ts
git commit -m "core: LayoutState.reset reverts graph to constructed baseline"
```

---

### Task 3: `Scheduler.forgetDevice()` + despawn devices-tombstone fix

Extract the disconnect logic into a shared `forgetDevice`, and fix the leak: a forgotten device must also tombstone its retained `railway/state/devices/<id>` topic (currently `handleDeviceDisconnect` clears schedule/clearance but leaves the device registration retained forever — the root cause of resurrecting ghosts).

**Files:**
- Modify: `packages/core/src/scheduler/scheduler.ts` (around `handleDeviceDisconnect`, lines 361–392)
- Test: `packages/server/src/server.test.ts` (integration through the real effect→broker path)

**Interfaces:**
- Consumes: existing `devices: Map<string, DeviceRecord>`, `trains: Map<string, TrainState>`, `registry`, `translateIntents`, `retryBlockedClearances`, `effects.updateState`.
- Produces: `forgetDevice(deviceId: string): ReadonlyArray<SchedulerEffect>`; `handleDeviceDisconnect` now delegates to it.

- [ ] **Step 1: Write the failing test**

Add to `server.test.ts` (uses the existing `makeServer`, `publishWireEvent`, `decode` helpers and `InMemoryBrokerClient`):

```typescript
describe('device disconnect clears retained device registration', () => {
  it('tombstones railway/state/devices/<id> so the train does not resurrect', () => {
    const { client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', { capabilities: ['core.controls_motion'] });

    // Sanity: the device is registered as a non-empty retained snapshot.
    const registered = client.retained.get('railway/state/devices/T1');
    expect(registered).toBeDefined();
    expect(decode<{ capabilities: string[] }>(registered!.payload).capabilities).toContain(
      'core.controls_motion',
    );

    publishWireEvent(client, 'device_disconnected', 'T1', {});

    // The retained device topic is now an empty tombstone (no capabilities).
    const after = client.retained.get('railway/state/devices/T1');
    expect(after).toBeDefined();
    expect(decode<Record<string, unknown>>(after!.payload)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/server test -- server`
Expected: FAIL — `after` payload still contains `capabilities` (the leak).

- [ ] **Step 3: Refactor `handleDeviceDisconnect` into `forgetDevice` + add the tombstone**

Replace the existing `handleDeviceDisconnect` (lines ~361–392) with:

```typescript
  private handleDeviceDisconnect(deviceId: string): ReadonlyArray<SchedulerEffect> {
    return this.forgetDevice(deviceId);
  }

  /**
   * Remove a device entirely: run each capability's disconnect hook, drop it
   * from the registry and (if it drives motion) the train table, and tombstone
   * its retained state so the visualiser and a freshly-reconnecting broker both
   * forget it. Shared by the `device_disconnected` event and the operator
   * "delete from memory" action so the two paths cannot drift.
   */
  forgetDevice(deviceId: string): ReadonlyArray<SchedulerEffect> {
    const device = this.devices.get(deviceId);
    if (!device) return [];

    const out: SchedulerEffect[] = [];
    for (const capId of device.capabilities) {
      const cap = this.registry.get(capId);
      if (!cap) continue;
      const oldState = device.capability_state.get(capId);
      const result = cap.invokeOnDeviceDisconnect(oldState);
      device.capability_state.set(capId, result.newState);
      out.push(...this.translateIntents(result.intents, deviceId));
    }

    this.devices.delete(deviceId);
    /*
     * Tombstone the retained device registration. Without this the broker keeps
     * replaying `railway/state/devices/<id>` to every new subscriber and the
     * dead device reappears as "registered, position unknown". An object with
     * no `capabilities` field is the devices view's recognised-empty shape.
     */
    out.push(effects.updateState('devices', deviceId, {}));

    if (device.capabilities.includes('core.controls_motion')) {
      out.push(
        effects.updateState('clearance', deviceId, {
          train_id: deviceId,
          cleared_edges: [],
        }),
        effects.updateState('schedule', deviceId, { train_id: deviceId }),
      );
      this.trains.delete(deviceId);
    }

    out.push(...this.retryBlockedClearances());
    return out;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trainframe/server test -- server`
Expected: PASS. Also run `pnpm --filter @trainframe/core test` to confirm no scheduler regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduler/scheduler.ts packages/server/src/server.test.ts
git commit -m "core: forgetDevice tombstones retained device state (fixes ghost resurrection)"
```

---

### Task 4: `Scheduler.reset()`

Clear all in-memory state: trains, devices, tags, deadlock/zone bookkeeping, and the layout (via `LayoutState.reset`).

**Files:**
- Modify: `packages/core/src/scheduler/scheduler.ts`
- Possibly modify: `packages/core/src/scheduler/tag-registry.ts` (add `clear()` if absent)
- Test: `packages/core/src/scheduler/scheduler.test.ts` (or `server.test.ts` if scheduler has no direct test harness — see note)

**Interfaces:**
- Consumes: private fields `trains`, `devices`, `tags`, `currentDeadlock`, `requestedSwitchPositions`, `zoneBoundaries`, `zoneOwnedMarkers`, `layout`; `LayoutState.reset()` (Task 2).
- Produces: `reset(): void`.

- [ ] **Step 1: Confirm the tag-registry clear path**

Run: `grep -n "clear" packages/core/src/scheduler/tag-registry.ts`
If `TagRegistry` has no `clear()`, add one:

```typescript
  /** Forget all tag bindings. */
  clear(): void {
    this.bindings.clear();
  }
```

(Use the actual private map name in `TagRegistry` — confirm by reading the file.)

- [ ] **Step 2: Write the failing test**

Prefer driving through the server (per the integration-test contract). Add to `server.test.ts`:

```typescript
describe('scheduler reset clears all in-memory state', () => {
  it('forgets trains and learned layout', () => {
    const { server, client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', { capabilities: ['core.controls_motion'] });
    expect(server.getScheduler().getTrainIds()).toContain('T1');

    server.getScheduler().reset();

    expect(server.getScheduler().getTrainIds()).toEqual([]);
    expect(server.getScheduler().getTrainState('T1')).toBeUndefined();
    // Layout reverts to the declared baseline (SIMPLE_LOOP has 4 markers).
    expect(server.getScheduler().getLayout().toLayout().markers).toHaveLength(4);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @trainframe/server test -- server`
Expected: FAIL — `reset is not a function`.

- [ ] **Step 4: Implement `reset`**

Add to the `Scheduler` class:

```typescript
  /**
   * Forget all runtime state — trains, devices, tags, deadlock/zone
   * bookkeeping — and revert the layout to its declared baseline. Pure
   * in-memory; the server is responsible for clearing the matching retained
   * broker topics (see Server.reset).
   */
  reset(): void {
    this.trains.clear();
    this.devices.clear();
    this.tags.clear();
    this.currentDeadlock = [];
    this.requestedSwitchPositions.clear();
    this.zoneBoundaries.clear();
    this.zoneOwnedMarkers.clear();
    this.layout.reset();
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @trainframe/server test -- server && pnpm --filter @trainframe/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scheduler/scheduler.ts packages/core/src/scheduler/tag-registry.ts packages/server/src/server.test.ts
git commit -m "core: Scheduler.reset clears all in-memory railway state"
```

---

### Task 5: Server retained-topic ledger + `Server.reset()`

The server learns which retained `railway/state/#` topics exist by subscribing at `start()`, then `reset()` tombstones every one (covering ghosts from a previous server instance) and re-establishes clean baselines.

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: `this.options.client` (BrokerClient — `subscribe`/`publish`), `this.scheduler` (the field behind `getScheduler()`), `effects.updateState`, existing `dispatchEffects`, `publishInitialDeadlockState()`, `learnMode.publishInitialState()`, module `encodeJson`.
- Produces: private `retainedStateTopics: Set<string>`; private `unsubscribeState: (() => void) | null`; `reset(): { topics_cleared: number }`; module function `emptyPayloadForStateTopic(topic): Uint8Array | null`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('Server.reset blank-slates server and broker', () => {
  it('tombstones retained ghosts the server never registered', () => {
    const { server, client } = makeServer();
    /*
     * Simulate a ghost left by a previous server/sim instance: a retained
     * device snapshot published directly to the broker after start(). The
     * server's railway/state/# ledger should still pick it up.
     */
    client.publish(
      'railway/state/devices/GHOST',
      new TextEncoder().encode(JSON.stringify({ capabilities: ['core.controls_motion'] })),
      { retain: true },
    );
    client.publish(
      'railway/state/schedule/GHOST',
      new TextEncoder().encode(JSON.stringify({ train_id: 'GHOST', route_id: 'r', stops: ['M1'], current_stop_index: 0 })),
      { retain: true },
    );

    const summary = server.reset();

    expect(summary.topics_cleared).toBeGreaterThanOrEqual(2);
    expect(decode<Record<string, unknown>>(client.retained.get('railway/state/devices/GHOST')!.payload)).toEqual({});
    expect(decode<Record<string, unknown>>(client.retained.get('railway/state/schedule/GHOST')!.payload)).toEqual({
      train_id: 'GHOST',
    });
    // Deadlock baseline re-established.
    expect(decode<{ trains: string[] }>(client.retained.get('railway/state/deadlock/active')!.payload).trains).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/server test -- server`
Expected: FAIL — `server.reset is not a function`.

- [ ] **Step 3: Add the ledger subscription in `start()`**

In `start()`, after the existing operator subscription and before the `publishLayoutState()` call, add:

```typescript
    /*
     * Maintain a ledger of retained state topics. The broker replays every
     * retained railway/state/* message on subscribe, so this picks up ghosts
     * published by a previous server instance or the simulator — exactly the
     * topics reset() must tombstone. Our own retained publishes feed back here
     * too, which is harmless (re-adding a topic we already track).
     */
    this.unsubscribeState = this.options.client.subscribe('railway/state/#', (msg) => {
      this.retainedStateTopics.add(msg.topic);
    });
```

Add the fields near the other private fields:

```typescript
  private readonly retainedStateTopics = new Set<string>();
  private unsubscribeState: (() => void) | null = null;
```

In `stop()`, tear it down:

```typescript
    this.unsubscribeState?.();
    this.unsubscribeState = null;
```

- [ ] **Step 4: Implement `reset()` and the helper**

Add the method to the `Server` class:

```typescript
  /**
   * Blank-slate the railway: forget all in-memory state and tombstone every
   * retained railway/state/* topic the broker is holding, then re-establish
   * clean baselines. Synchronous — the topic ledger is maintained from start().
   */
  reset(): { topics_cleared: number } {
    let cleared = 0;
    for (const topic of this.retainedStateTopics) {
      const payload = emptyPayloadForStateTopic(topic);
      if (!payload) continue;
      this.options.client.publish(topic, payload, { retain: true });
      cleared += 1;
    }
    this.scheduler.reset();
    /*
     * Re-establish the singleton baselines (layout/deadlock/track_learning),
     * overwriting whatever the ledger loop left. The layout is the live, now
     * empty graph — not the static declared layout.
     */
    this.dispatchEffects([
      effects.updateState('layout', this.scheduler.getLayout().name, this.scheduler.getLayout().toLayout()),
    ]);
    this.publishInitialDeadlockState();
    this.learnMode.publishInitialState();
    return { topics_cleared: cleared };
  }
```

> NOTE: confirm the private scheduler field name by reading the constructor / `getScheduler()`. If it is not `this.scheduler`, use the actual field. `LayoutState` exposes `.name` (public readonly) and `.toLayout()`.

Add the module-level helper near `encodeJson` (bottom of the file):

```typescript
/**
 * The recognised-empty retained payload that tells each state-family consumer
 * "this entity is gone". Per-id families get a crafted tombstone; the singleton
 * families (layout/deadlock/track_learning) are re-published as clean baselines
 * by reset() directly, so this returns null for them.
 */
function emptyPayloadForStateTopic(topic: string): Uint8Array | null {
  const parts = topic.split('/');
  const family = parts[2];
  const id = parts.slice(3).join('/');
  if (family === 'devices') return encodeJson({});
  if (family === 'schedule') return encodeJson({ train_id: id });
  if (family === 'clearance') return encodeJson({ train_id: id, cleared_edges: [] });
  return null;
}
```

(Import `effects` from `@trainframe/core` if not already imported in `server.ts` — check the existing imports; `SchedulerEffect` is already referenced so the effects barrel is likely available.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @trainframe/server test -- server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.test.ts
git commit -m "server: retained-topic ledger + reset() blank-slates broker and memory"
```

---

### Task 6: `Server.deleteTrain()` + `Server.pruneOrphanMarkers()`

Thin server methods that compose the scheduler/layout mutations and dispatch their effects.

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: `this.scheduler.forgetDevice` (Task 3), `this.scheduler.getTrainState`, `this.scheduler.getLayout().pruneOrphanMarkers()` (Task 1), `dispatchEffects`, `effects.updateState`.
- Produces: `deleteTrain(trainId: string): boolean` (false if unknown), `pruneOrphanMarkers(): string[]`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('Server.deleteTrain', () => {
  it('forgets a known train and reports success; 404s an unknown one', () => {
    const { server, client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', { capabilities: ['core.controls_motion'] });

    expect(server.deleteTrain('NOPE')).toBe(false);
    expect(server.deleteTrain('T1')).toBe(true);
    expect(server.getScheduler().getTrainState('T1')).toBeUndefined();
    expect(decode<Record<string, unknown>>(client.retained.get('railway/state/devices/T1')!.payload)).toEqual({});
  });
});

describe('Server.pruneOrphanMarkers', () => {
  it('removes zero-edge markers and republishes the layout', () => {
    const { server, client } = makeServer();
    server.getScheduler().getLayout().upsertMarker('ORPHAN', 'block_boundary');

    const pruned = server.pruneOrphanMarkers();

    expect(pruned).toEqual(['ORPHAN']);
    const layout = decode<{ markers: Array<{ id: string }> }>(
      client.retained.get('railway/state/layout/simple-loop')!.payload,
    );
    expect(layout.markers.map((m) => m.id)).not.toContain('ORPHAN');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @trainframe/server test -- server`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement both methods**

```typescript
  /**
   * Forget a train entirely (operator "delete from memory"). Returns false if
   * no such device is registered, so the HTTP layer can 404. Shares the same
   * forgetDevice path as device_disconnected.
   */
  deleteTrain(trainId: string): boolean {
    const fx = this.scheduler.forgetDevice(trainId);
    if (fx.length === 0) return false;
    this.dispatchEffects(fx);
    return true;
  }

  /**
   * Remove every orphaned (zero-edge) marker from the live layout and
   * republish the pruned graph. Returns the removed marker ids.
   */
  pruneOrphanMarkers(): string[] {
    const pruned = this.scheduler.getLayout().pruneOrphanMarkers();
    if (pruned.length > 0) {
      this.dispatchEffects([
        effects.updateState('layout', this.scheduler.getLayout().name, this.scheduler.getLayout().toLayout()),
      ]);
    }
    return pruned;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @trainframe/server test -- server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.test.ts
git commit -m "server: deleteTrain and pruneOrphanMarkers compose core mutations"
```

---

### Task 7: Admin HTTP routes — `DELETE /api/trains/:id`, `POST /api/maintenance/prune-markers`, `POST /api/maintenance/reset`

Wire the new server methods to HTTP. `matchRoute` currently handles only GET and POST; add a DELETE branch and two maintenance POSTs, and add `DELETE` to the CORS allow-methods header.

**Files:**
- Modify: `packages/server/src/admin-http.ts`
- Test: `packages/server/src/admin-http.test.ts` (mirror the existing admin-http test idiom — confirm by reading it first)

**Interfaces:**
- Consumes: `this.server.deleteTrain`, `this.server.pruneOrphanMarkers`, `this.server.reset`; existing helpers `json`, `addCors`, `matchRoute`.
- Produces: routes `DELETE /api/trains/:id` → `{ deleted }` | 404; `POST /api/maintenance/prune-markers` → `{ pruned }`; `POST /api/maintenance/reset` → `{ topics_cleared }`.

- [ ] **Step 1: Write the failing tests**

Read `packages/server/src/admin-http.test.ts` for the exact harness (it constructs `AdminHttpServer` + a `Server` and does real `fetch` against `127.0.0.1:<port>`). Add:

```typescript
it('DELETE /api/trains/:id forgets a known train and 404s an unknown one', async () => {
  // ...register T1 via the harness, then:
  const ok = await fetch(`${baseUrl}/api/trains/T1`, { method: 'DELETE' });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ deleted: 'T1' });

  const missing = await fetch(`${baseUrl}/api/trains/NOPE`, { method: 'DELETE' });
  expect(missing.status).toBe(404);
});

it('POST /api/maintenance/prune-markers returns the pruned ids', async () => {
  // ...add an orphan marker via the server's scheduler, then:
  const res = await fetch(`${baseUrl}/api/maintenance/prune-markers`, { method: 'POST' });
  expect(res.status).toBe(200);
  expect((await res.json()).pruned).toContain('ORPHAN');
});

it('POST /api/maintenance/reset blank-slates and reports cleared topics', async () => {
  const res = await fetch(`${baseUrl}/api/maintenance/reset`, { method: 'POST' });
  expect(res.status).toBe(200);
  expect(typeof (await res.json()).topics_cleared).toBe('number');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @trainframe/server test -- admin-http`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Add the routes and handlers**

In `matchRoute`, after the `if (method === 'GET') { return this.matchQueryRoute(...); }` block, add a DELETE branch:

```typescript
    if (method === 'DELETE') {
      const del = url.match(/^\/api\/trains\/([^/]+)$/);
      if (del?.[1]) {
        const id = decodeURIComponent(del[1]);
        return { needsBody: false, handler: (_b, res) => this.deleteTrain(id, res) };
      }
      return undefined;
    }
```

In the POST section (after the `/api/tags` route), add:

```typescript
    if (url === '/api/maintenance/prune-markers') {
      return { needsBody: false, handler: (_b, res) => this.pruneMarkers(res) };
    }
    if (url === '/api/maintenance/reset') {
      return { needsBody: false, handler: (_b, res) => this.resetState(res) };
    }
```

Add the handler methods to the class:

```typescript
  private deleteTrain(trainId: string, res: ServerResponse): void {
    if (!this.server.deleteTrain(trainId)) {
      json(res, 404, { error: `Unknown train: ${trainId}`, code: 'not_found' });
      return;
    }
    json(res, 200, { deleted: trainId });
  }

  private pruneMarkers(res: ServerResponse): void {
    json(res, 200, { pruned: this.server.pruneOrphanMarkers() });
  }

  private resetState(res: ServerResponse): void {
    json(res, 200, this.server.reset());
  }
```

Update `addCors`:

```typescript
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @trainframe/server test -- admin-http`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/admin-http.ts packages/server/src/admin-http.test.ts
git commit -m "server: admin routes for delete-train, prune-markers, reset"
```

---

### Task 8: Visualiser shared admin-API client

Replace the ad-hoc `fetch` in `UnknownTags` with one typed module that all admin calls go through.

**Files:**
- Create: `packages/visualiser/src/api/admin-client.ts`
- Create: `packages/visualiser/src/api/admin-client.test.ts`
- Modify: `packages/visualiser/src/components/UnknownTags.tsx`

**Interfaces:**
- Consumes: `fetch`, the `adminApiUrl` string (from `loadAdminApiUrl`).
- Produces: `AdminApiError`; `assignTag(baseUrl, { tagId, kind, targetId })`; `revokeClearance(baseUrl, trainId)`; `deleteTrain(baseUrl, trainId)`; `pruneMarkers(baseUrl): Promise<string[]>`; `resetState(baseUrl): Promise<{ topics_cleared: number }>`.

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, deleteTrain, pruneMarkers } from './admin-client.js';

afterEach(() => vi.restoreAllMocks());

describe('admin-client', () => {
  it('deleteTrain issues a DELETE and resolves on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"deleted":"T1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteTrain('http://h:3000', 'T 1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://h:3000/api/trains/T%201',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws AdminApiError with the status on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    await expect(deleteTrain('http://h:3000', 'T1')).rejects.toBeInstanceOf(AdminApiError);
  });

  it('pruneMarkers returns the pruned id array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"pruned":["A","B"]}', { status: 200 })));
    expect(await pruneMarkers('http://h:3000')).toEqual(['A', 'B']);
  });
});
```

> This is the one place a mock (`fetch`) is acceptable — there is no real HTTP seam in a unit test and the contract is the request shape. The server side is covered by real-broker integration tests in Tasks 5–7.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/visualiser test -- admin-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

```typescript
/**
 * Typed client for the server's admin HTTP API. One place for every
 * operator-initiated request/response action, so components don't scatter
 * bare fetch calls. Base URL comes from the visualiser's admin-api config.
 */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AdminApiError(res.status, text || res.statusText);
  }
  return res;
}

export async function assignTag(
  baseUrl: string,
  args: { tagId: string; kind: 'marker' | 'vehicle'; targetId: string },
): Promise<void> {
  await request(baseUrl, '/api/tags', {
    method: 'POST',
    body: JSON.stringify({ tag_id: args.tagId, assigned_kind: args.kind, target_id: args.targetId }),
  });
}

export async function revokeClearance(baseUrl: string, trainId: string): Promise<void> {
  await request(baseUrl, `/api/trains/${encodeURIComponent(trainId)}/revoke_clearance`, {
    method: 'POST',
    body: '{}',
  });
}

export async function deleteTrain(baseUrl: string, trainId: string): Promise<void> {
  await request(baseUrl, `/api/trains/${encodeURIComponent(trainId)}`, { method: 'DELETE' });
}

export async function pruneMarkers(baseUrl: string): Promise<string[]> {
  const res = await request(baseUrl, '/api/maintenance/prune-markers', { method: 'POST', body: '{}' });
  const body = (await res.json()) as { pruned?: string[] };
  return body.pruned ?? [];
}

export async function resetState(baseUrl: string): Promise<{ topics_cleared: number }> {
  const res = await request(baseUrl, '/api/maintenance/reset', { method: 'POST', body: '{}' });
  return (await res.json()) as { topics_cleared: number };
}
```

- [ ] **Step 4: Migrate `UnknownTags` onto `assignTag`**

In `UnknownTags.tsx`, replace the inline `fetch(...)` block (~lines 73–81) with a call to `assignTag(adminApiUrl, { tagId, kind, targetId })`, keeping the existing `submitting`/`error` `useState` and try/catch/finally. Import from `../api/admin-client.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @trainframe/visualiser test -- admin-client && pnpm --filter @trainframe/visualiser test -- UnknownTags`
Expected: PASS (UnknownTags' own tests still green after the swap).

- [ ] **Step 6: Commit**

```bash
git add packages/visualiser/src/api packages/visualiser/src/components/UnknownTags.tsx
git commit -m "visualiser: shared admin-api client; migrate UnknownTags onto it"
```

---

### Task 9: `ConfirmButton` component

A reusable confirm-before-act button: a one-click two-step confirm for routine destructive actions, and an optional typed-phrase gate for the heavy "blank slate".

**Files:**
- Create: `packages/visualiser/src/components/ConfirmButton.tsx`
- Create: `packages/visualiser/src/components/ConfirmButton.css`
- Create: `packages/visualiser/src/components/ConfirmButton.test.tsx`

**Interfaces:**
- Consumes: `Button` from `@trainframe/ui-kit`.
- Produces: `ConfirmButton(props: { label: string; confirmLabel?: string; requirePhrase?: string; onConfirm: () => void | Promise<void>; variant?: 'secondary' | 'danger'; disabled?: boolean })`.

- [ ] **Step 1: Write the failing test**

```typescript
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from './ConfirmButton.js';

describe('ConfirmButton', () => {
  it('requires a second click before firing onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Delete" onConfirm={onConfirm} variant="danger" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('gates on a typed phrase when requirePhrase is set', () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Blank slate" requirePhrase="RESET" onConfirm={onConfirm} variant="danger" />);
    fireEvent.click(screen.getByRole('button', { name: 'Blank slate' }));
    const confirm = screen.getByRole('button', { name: /confirm/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'RESET' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/visualiser test -- ConfirmButton`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```typescript
import { Button } from '@trainframe/ui-kit';
import { useState } from 'react';
import './ConfirmButton.css';

interface ConfirmButtonProps {
  readonly label: string;
  readonly confirmLabel?: string;
  /** When set, the confirm step is gated on typing this exact phrase. */
  readonly requirePhrase?: string;
  readonly onConfirm: () => void | Promise<void>;
  readonly variant?: 'secondary' | 'danger';
  readonly disabled?: boolean;
}

/**
 * Destructive action with an inline confirm step — no modal. First click arms
 * it; a second click (optionally gated on a typed phrase) fires onConfirm.
 * Clicking Cancel or blurring resets it.
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  requirePhrase,
  onConfirm,
  variant = 'danger',
  disabled = false,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [phrase, setPhrase] = useState('');

  if (!armed) {
    return (
      <Button variant={variant} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }

  const phraseOk = requirePhrase === undefined || phrase === requirePhrase;
  return (
    <span className="tf-confirm">
      {requirePhrase !== undefined && (
        <input
          className="tf-confirm__phrase"
          type="text"
          aria-label={`Type ${requirePhrase} to confirm`}
          placeholder={requirePhrase}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
        />
      )}
      <Button
        variant={variant}
        disabled={!phraseOk}
        onClick={() => {
          setArmed(false);
          setPhrase('');
          void onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          setArmed(false);
          setPhrase('');
        }}
      >
        Cancel
      </Button>
    </span>
  );
}
```

`ConfirmButton.css`:

```css
.tf-confirm {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
}
.tf-confirm__phrase {
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--tf-vis-color-warn-border);
  border-radius: 4px;
  font: inherit;
  width: 6rem;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trainframe/visualiser test -- ConfirmButton`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/visualiser/src/components/ConfirmButton.tsx packages/visualiser/src/components/ConfirmButton.css packages/visualiser/src/components/ConfirmButton.test.tsx
git commit -m "visualiser: ConfirmButton — inline confirm with optional typed phrase"
```

---

### Task 10: Per-train cards with Stop + Delete actions

Give each train row real actions. Route assignment stays in the existing `ScheduleAssigner` (it owns the stop-builder); the cards add what's missing: **Stop** (revoke clearance) and **Delete from memory**. Threads `adminApiUrl` from `App` → `DevicesPanel` → `TrainRow`.

**Files:**
- Modify: `packages/visualiser/src/components/DevicesPanel.tsx`
- Modify: `packages/visualiser/src/components/DevicesPanel.css`
- Test: `packages/visualiser/src/components/DevicesPanel.test.tsx` (confirm/extend the existing one)

**Interfaces:**
- Consumes: `revokeClearance`, `deleteTrain`, `AdminApiError` from `../api/admin-client.js`; `ConfirmButton` (Task 9); `Button` from ui-kit. New prop `adminApiUrl: string` on `DevicesPanel`.
- Produces: `DevicesPanel` accepts `{ adminApiUrl }`; `TrainRow` renders Stop + Delete actions with inline error text.

- [ ] **Step 1: Write the failing test**

```typescript
it('deletes a train from memory via the admin client', async () => {
  const deleteSpy = vi.spyOn(adminClient, 'deleteTrain').mockResolvedValue();
  // ...render DevicesPanel with adminApiUrl + a registered train T1 (use the
  // existing test harness that publishes a retained device snapshot)...
  fireEvent.click(within(screen.getByTestId('device-row-T1')).getByRole('button', { name: /delete/i }));
  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
  await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('http://127.0.0.1:3000', 'T1'));
});
```

> Read the existing `DevicesPanel.test.tsx` first for its render harness (BrokerProvider + retained device publish) and mirror it. Import the client module namespace so `vi.spyOn` works: `import * as adminClient from '../api/admin-client.js'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/visualiser test -- DevicesPanel`
Expected: FAIL — no Delete button / `adminApiUrl` prop missing.

- [ ] **Step 3: Add the prop and action UI**

Change the `DevicesPanel` signature to accept the URL and thread it to `TrainRow`:

```typescript
export function DevicesPanel({ adminApiUrl }: { readonly adminApiUrl: string }) {
```

Pass `adminApiUrl={adminApiUrl}` into each `<TrainRow ... />`. Extend `TrainRowProps` with `readonly adminApiUrl: string;` and add the actions to `TrainRow`:

```typescript
function TrainRow({ device, schedule, marker, status, highlighted, adminApiUrl }: TrainRowProps) {
  const where = describeTrainPosition(marker, status);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<void>) => () => {
    setError(null);
    action().catch((err) => setError(err instanceof Error ? err.message : 'request failed'));
  };

  return (
    <li
      className={rowClass(highlighted)}
      data-testid={`device-row-${device.device_id}`}
      data-entity-id={device.device_id}
      data-highlighted={highlighted ? 'true' : undefined}
    >
      <span
        className="tf-devices__row-id"
        style={{ color: trainColor(device.device_id), fontWeight: 'bold' }}
      >
        {device.device_id}
      </span>
      <span className="tf-devices__row-meta">
        {schedule ? `route ${schedule.stops.join(' → ')}` : 'no schedule'}
      </span>
      <span className="tf-devices__row-meta">{where}</span>
      <span className="tf-devices__row-actions">
        <Button variant="secondary" onClick={run(() => revokeClearance(adminApiUrl, device.device_id))}>
          Stop
        </Button>
        <ConfirmButton
          label="Delete"
          confirmLabel="Confirm delete"
          variant="danger"
          onConfirm={() => deleteTrain(adminApiUrl, device.device_id)}
        />
      </span>
      {error && (
        <span className="tf-devices__row-error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}
```

Add imports at the top of the file: `useState` from `react`, `Button` from `@trainframe/ui-kit`, `ConfirmButton` from `./ConfirmButton.js`, and `{ deleteTrain, revokeClearance }` from `../api/admin-client.js`.

Add CSS to `DevicesPanel.css`:

```css
.tf-devices__row-actions {
  display: inline-flex;
  gap: 0.4rem;
  margin-left: auto;
}
.tf-devices__row-error {
  flex-basis: 100%;
  color: var(--tf-vis-color-warn-text);
  font-size: 0.85em;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trainframe/visualiser test -- DevicesPanel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/visualiser/src/components/DevicesPanel.tsx packages/visualiser/src/components/DevicesPanel.css packages/visualiser/src/components/DevicesPanel.test.tsx
git commit -m "visualiser: per-train cards with Stop and Delete-from-memory actions"
```

---

### Task 11: Maintenance "danger zone" strip

A distinct panel with **Prune orphaned markers** and **Blank slate**, using the warn tokens.

**Files:**
- Create: `packages/visualiser/src/components/MaintenancePanel.tsx`
- Create: `packages/visualiser/src/components/MaintenancePanel.css`
- Create: `packages/visualiser/src/components/MaintenancePanel.test.tsx`

**Interfaces:**
- Consumes: `pruneMarkers`, `resetState` from `../api/admin-client.js`; `ConfirmButton`; `Panel` from ui-kit. Prop `adminApiUrl: string`.
- Produces: `MaintenancePanel({ adminApiUrl })`.

- [ ] **Step 1: Write the failing test**

```typescript
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as adminClient from '../api/admin-client.js';
import { MaintenancePanel } from './MaintenancePanel.js';

describe('MaintenancePanel', () => {
  it('prunes orphan markers and reports the result', async () => {
    vi.spyOn(adminClient, 'pruneMarkers').mockResolvedValue(['ORPHAN-A', 'ORPHAN-B']);
    render(<MaintenancePanel adminApiUrl="http://h:3000" />);
    fireEvent.click(screen.getByRole('button', { name: /prune/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/2 marker/i));
  });

  it('requires the typed phrase before blank-slate', () => {
    const reset = vi.spyOn(adminClient, 'resetState').mockResolvedValue({ topics_cleared: 0 });
    render(<MaintenancePanel adminApiUrl="http://h:3000" />);
    fireEvent.click(screen.getByRole('button', { name: /blank slate/i }));
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    expect(reset).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/visualiser test -- MaintenancePanel`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panel**

```typescript
import { Panel } from '@trainframe/ui-kit';
import { useState } from 'react';
import { pruneMarkers, resetState } from '../api/admin-client.js';
import { ConfirmButton } from './ConfirmButton.js';
import './MaintenancePanel.css';

/**
 * Destructive maintenance actions, fenced off as a "danger zone". Prune sweeps
 * up orphaned (zero-edge) markers; Blank slate forgets the entire railway and
 * is gated on a typed phrase.
 */
export function MaintenancePanel({ adminApiUrl }: { readonly adminApiUrl: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<string>) => () => {
    setError(null);
    setMessage(null);
    action()
      .then(setMessage)
      .catch((err) => setError(err instanceof Error ? err.message : 'request failed'));
  };

  return (
    <Panel label="Maintenance" className="tf-maintenance" data-testid="maintenance-panel">
      <p className="tf-maintenance__hint">Destructive — these forget state and cannot be undone.</p>
      <div className="tf-maintenance__actions">
        <ConfirmButton
          label="Prune orphaned markers"
          confirmLabel="Confirm prune"
          variant="secondary"
          onConfirm={run(async () => {
            const pruned = await pruneMarkers(adminApiUrl);
            return pruned.length === 0 ? 'Nothing to prune.' : `Pruned ${pruned.length} marker(s).`;
          })}
        />
        <ConfirmButton
          label="Blank slate"
          confirmLabel="Confirm blank slate"
          requirePhrase="RESET"
          variant="danger"
          onConfirm={run(async () => {
            const { topics_cleared } = await resetState(adminApiUrl);
            return `Blank slate done — cleared ${topics_cleared} retained topic(s).`;
          })}
        />
      </div>
      {message && (
        <p className="tf-maintenance__message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="tf-maintenance__error" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}
```

`MaintenancePanel.css`:

```css
.tf-maintenance {
  border: 2px solid var(--tf-vis-color-warn-border);
  background-color: var(--tf-vis-color-warn-bg);
}
.tf-maintenance__hint {
  color: var(--tf-vis-color-warn-text);
  margin: 0 0 0.5rem;
  font-size: 0.9em;
}
.tf-maintenance__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
}
.tf-maintenance__message {
  color: var(--tf-vis-color-fg);
  margin: 0.5rem 0 0;
}
.tf-maintenance__error {
  color: var(--tf-vis-color-warn-text);
  margin: 0.5rem 0 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trainframe/visualiser test -- MaintenancePanel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/visualiser/src/components/MaintenancePanel.tsx packages/visualiser/src/components/MaintenancePanel.css packages/visualiser/src/components/MaintenancePanel.test.tsx
git commit -m "visualiser: maintenance danger-zone panel (prune + blank slate)"
```

---

### Task 12: Wire the panels into `App`

Pass `adminApiUrl` into `DevicesPanel` and mount `MaintenancePanel`.

**Files:**
- Modify: `packages/visualiser/src/App.tsx`

**Interfaces:**
- Consumes: existing `adminApiUrl` state (`App.tsx:25`), `DevicesPanel` (now needs the prop), `MaintenancePanel`.

- [ ] **Step 1: Make the edits**

In `App.tsx`:
- Import `MaintenancePanel` from `./components/MaintenancePanel.js`.
- Change `<DevicesPanel />` to `<DevicesPanel adminApiUrl={adminApiUrl} />`.
- Add `<MaintenancePanel adminApiUrl={adminApiUrl} />` immediately after `<DevicesPanel ... />` (logically adjacent — both are train/state control).

- [ ] **Step 2: Typecheck + full visualiser test run**

Run: `pnpm --filter @trainframe/visualiser typecheck && pnpm --filter @trainframe/visualiser test`
Expected: PASS — all visualiser tests green, no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/visualiser/src/App.tsx
git commit -m "visualiser: mount MaintenancePanel and wire adminApiUrl into DevicesPanel"
```

---

### Task 13: Protocol note + status doc

Document the deregister tombstone and record the work.

**Files:**
- Modify: `docs/spec/protocol-v0.2.md` (or the current spec version — confirm the latest in `docs/spec/`)
- Modify: `docs/status.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Add the protocol note**

In the retained-state section describing `railway/state/devices/{device_id}`, add one line:

> A retained payload with no `capabilities` field (e.g. `{}`) is a deregister tombstone: consumers drop the device. Published by the server when a device disconnects or is deleted from memory. No version bump — no shape change.

- [ ] **Step 2: Update the status doc**

Add a short entry under the current status summarising: blank-slate reset, orphan-marker prune, delete-train-from-memory, and the retained-`devices` leak fix; note the visualiser maintenance panel + per-train Stop/Delete actions.

- [ ] **Step 3: Commit**

```bash
git add docs/spec docs/status.md
git commit -m "docs: deregister tombstone note + status update for state lifecycle"
```

---

### Task 14: Playwright journey (ui-tests)

End-to-end proof through the real harness: spawn trains, delete one from memory, prune markers, blank-slate — observing the visualiser empty.

**Files:**
- Create: `packages/ui-tests/tests/state-lifecycle.spec.ts`

**Interfaces:**
- Consumes: the existing harness + helpers in `packages/ui-tests/src/playwright-helpers.ts` and the model `packages/ui-tests/tests/multi-train-journey.spec.ts`.

- [ ] **Step 1: Read the model spec and helpers**

Read `packages/ui-tests/tests/multi-train-journey.spec.ts` and `packages/ui-tests/src/playwright-helpers.ts` to learn the exact harness startup (server + broker + both UIs), the page fixtures, and the data attributes (`[data-train-id]`, `[data-marker-id]`, `[data-testid="device-row-..."]`).

- [ ] **Step 2: Write the journey spec**

Mirror the model's setup, then assert this journey:

1. Spawn two trains via the sim-ui (`Spawn train` button auto-increments the id).
2. In the visualiser, confirm both `[data-testid="device-row-T1"]` and `device-row-T2` exist.
3. Click **Delete** then **Confirm delete** on T1's card; assert `device-row-T1` disappears and `device-row-T2` remains.
4. Click **Prune orphaned markers** → **Confirm prune**; assert the `maintenance-panel` `role="status"` shows a prune result.
5. Click **Blank slate**, type `RESET`, **Confirm blank slate**; assert the trains group and markers group both return to their empty-hint state (`No trains registered yet.` / `No markers on the layout yet.`).

Use the existing helpers for waiting/polling (e.g. `expect(locator).toBeVisible()` / `toHaveCount(0)`), matching the model spec's idioms exactly.

- [ ] **Step 3: Run the spec**

Stop the user's dev broker first if it's bound (the harness binds the same port — see `docs/contributing/driving-the-ui-live.md`):

Run: `pnpm --filter @trainframe/ui-tests test -- state-lifecycle`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui-tests/tests/state-lifecycle.spec.ts
git commit -m "ui-tests: state-lifecycle journey (delete train, prune, blank slate)"
```

---

## Final verification

- [ ] **Run the full gate:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] Confirm coverage didn't drop below floors (protocol 90/85, core 75/75, simulator 80/75).
- [ ] Live smoke (optional, against the running dev stack): open the visualiser, delete a ghost train, prune the floating markers, blank-slate, and confirm the panel from the original screenshot is now clean.

## Self-review notes (resolved during planning)

- **No universal tombstone** — verified each consumer's recognised-empty shape; encoded in Global Constraints + `emptyPayloadForStateTopic`.
- **Ghosts survive server restart** — handled by the retained-topic ledger (Task 5), not the in-memory maps.
- **`LayoutState` had no removal/reset** — added in Tasks 1–2; constructor refactored into `loadFromLayout`.
- **Despawn leak** — the actual root cause; fixed in Task 3 and regression-tested.
- **Route assignment scope** — intentionally left in the existing `ScheduleAssigner`; the cards add Stop + Delete only. (Flagged to the user.)
- **`fetch` mock in Task 8** — the one acceptable mock (no real HTTP seam in a visualiser unit test); server behaviour is covered by real-broker integration tests in Tasks 5–7.
