# ADR-013: Simulator is the physical twin; visualiser is the system view

## Status

Accepted

## Context

The project carries two browser-based packages that look superficially
similar — both subscribe to the same MQTT bus, both render an SVG of the
layout, both let an operator interact with a running railway. They are
not the same thing, and treating them as if they were has already produced
incorrect design pulls (e.g. proposing to merge them into one UI).

The two packages exist for different reasons and serve different audiences:

- **`@trainframe/simulator-ui`** is a virtual stand-in for *the physical
  world*: a wooden Brio-style smart railway with smart devices on the
  track. In a real installation this UI does not exist — its job is filled
  by actual track, actual trains, actual switches. When the simulator-ui
  renders a train, that is the equivalent of the kid looking at the
  wooden train on the carpet. When it renders a station gate dwelling,
  that is the equivalent of the train physically slowing and stopping at
  the platform. The simulator-ui's audience, long-term, is *a child
  playing with the toy*.

- **`@trainframe/visualiser`** is the Trainframe *system's* window into the
  world. It subscribes to retained MQTT state and live events and renders
  what the system *knows*: marker identities, current routes, schedules,
  clearance / block ownership, detected deadlocks, discovery of new
  topology. Long-term it is a companion app — an e-paper display unit or
  tablet running beside the physical layout — that helps an operator
  understand what the system has inferred and what it's planning.

The two packages communicate only over the bus, exactly as a real
hardware deployment would. They share no React components, no state, no
imports.

This split has not been written down in an ADR until now. It has been
quietly understood and quietly violated. Most recently, the simulator-ui
acquired a schedule-assignment form because that was the easiest place
to put the plumbing — but schedule assignment is operator intent against
the system, not a physical action against the track. The form belongs on
the visualiser side.

## Decision

### Each package's surface

The **simulator-ui** renders only what would be physically visible IRL:

- The shape of the track (pieces, not markers-as-labels).
- Where trains are, and that they're moving or stopped.
- The current position of each switch (because real switches physically
  move).
- A station platform's presence (because a real station is a physical
  thing on the layout).
- Optional fault-injection knobs (overshoot rate, miss rate, etc.) —
  these are the *developer's* equivalent of physical wear and tear, and
  belong behind a "Developer" drawer that is collapsed by default.

The simulator-ui does **not** render:

- Marker *names* (M3, SA, …). Markers exist physically as RFID tags
  attached to track pieces; their identity is opaque to the kid. A
  marked track piece shows a small tag icon, nothing more.
- Current routes, schedules, current-target-stop indicators.
- Clearance / block ownership / which sections each train holds.
- Deadlock state, anomalies, system-level alerts.
- Anything else that lives in the Trainframe protocol's semantic layer.

The **visualiser** renders the system's interpretation:

- Marker labels.
- Schedule list with each train's current target stop highlighted.
- Clearance overlay (which edges each train holds, in per-train hues).
- Deadlock banner with recovery hints.
- Discovery indicators for inferred edges.
- Anything that depends on Trainframe's semantic model.

Schedule assignment, clearance revocation, and other operator actions
that target the *system* (not a physical device) live on the visualiser
side. Despawning a train, picking up a train, flipping a switch by hand —
these are physical actions and live on the simulator side.

### Code-level guarantee

The two packages must not share React components, state, or imports. A
Biome `noRestrictedImports` rule (or equivalent test) enforces that
`@trainframe/simulator-ui` does not import from `@trainframe/visualiser`
and vice versa.

Genuinely shared UI primitives (Button, Panel, theme tokens, the
`stop-picker` widget that both apps happen to need) live in a new
`@trainframe/ui-kit` package that both apps may consume. The ui-kit is
the **only** path by which code can move between them, and the ui-kit
itself is forbidden from depending on either `simulator-ui` or
`visualiser`.

The boundary is mechanically enforced because human memory drifts as
projects grow.

### What the two apps share

Only:
- The protocol (`@trainframe/protocol`).
- The MQTT broker as transport.
- Genuinely abstract UI primitives in `@trainframe/ui-kit`.

That's it. They do not share schedules, marker bindings, train
configurations, or any domain-shaped object. Each package observes the
bus and renders its own interpretation.

### Consequences for current code

- The schedule-assignment UI moves from `simulator-ui/SimControls` to a
  new visualiser component. To make this work across processes, a new
  operator-side wire topic carries the schedule-assignment intent; both
  the in-browser `SimRunner` and `@trainframe/server` subscribe and
  invoke `assignSchedule` on their respective scheduler. The visualiser
  publishes; both backends consume.
- Marker name labels on the simulator-ui canvas are removed. A marked
  piece shows a small RFID-tag icon, no label. The labels still appear
  on the visualiser side.
- Fault-injection knobs (overshoot rate, miss rate, train length input)
  collapse into a "Developer" drawer in the simulator-ui — hidden by
  default, revealed by a toggle.
- Per-train interactions (despawn, revoke clearance) move onto the train
  icons in the simulator-ui canvas. "Revoke clearance" is conceptually
  an operator-intent action, but for the simulator-ui's child audience
  it's framed as "make this train stop respecting the system" — the
  same recovery a kid would do by picking the train up.
- The simulator-ui's `Build (step-by-step)` form-based layout editor is
  replaced by a drag-from-palette track-piece editor. Pieces are the
  physical units (straight, curve, junction, station platform, terminus,
  …); the system learns marker identities at runtime via `tag_observed`
  events when a train crosses a marked piece. No marker names need to be
  typed by the kid.

### What we don't change

- The protocol. Both apps continue to use the existing MQTT topics and
  envelope shapes. The new operator-command topic is an addition, not a
  redesign.
- The scheduler, planner, simulator engine, or any non-UI package.
- The visualiser's existing read-only feel for state that genuinely *is*
  read-only (event log, deadlock banner, clearance overlay). The
  visualiser becomes interactive only for *operator intents* that have
  to live somewhere.

## How this is enforced

Three `overrides` blocks in `biome.json` use the `style.noRestrictedImports` rule to
raise a Biome **error** (blocks `pnpm lint`) if:

- any file under `packages/simulator-ui/**` imports `@trainframe/visualiser`,
- any file under `packages/visualiser/**` imports `@trainframe/simulator-ui`, or
- any file under `packages/ui-kit/**` imports either app.

`pnpm lint` runs in CI and blocks merging. The messages embedded in the Biome config
point at this ADR so contributors can find the rationale immediately.

## Consequences

- The conceptual split is now mechanically enforced. Future contributors
  (including future-Claude) can't accidentally drift toward a merged
  surface without breaking lint or tests.
- The simulator-ui becomes substantially smaller and easier to evolve
  toward the kid-facing future. The visualiser gains a small amount of
  interactivity for the operator actions that genuinely belong there.
- A new `@trainframe/ui-kit` package exists with a tiny initial surface
  (Button, Panel, theme tokens, stop-picker). It is the *only* sanctioned
  code-sharing surface between the two apps and must remain narrow.
- Long-term targets get clearer: the simulator-ui's roadmap is "more
  IRL feel" (drag-to-place track, drag-to-pick-up trains, sound, ease-in
  animations), and the visualiser's roadmap is "more operator value"
  (schedule editing, route inspection, e-paper-friendly rendering).
- Future bug reports of the form "the X feature should be in the other
  app" become easy to resolve: apply the rule.
