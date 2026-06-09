# ADR-018: Multi-gate semantics — conjunctive AND when several gates_clearance devices gate the same marker

## Status

Proposed.

Resolves the open design question from CLAUDE.md: "Multi-gate semantics
when several `gates_clearance` devices gate the same marker." Builds on
[ADR-002](002-clearance-model.md) (clearance, not commands; default state
stopped/safe) and [ADR-011](011-section-as-edge-plus-boundary-markers.md)
(block exclusivity from the section-pair rule).

## Context

A marker can be gated by more than one `gates_clearance` device. A platform
marker might be gated by a station (dwell timer) *and* a crane (until
payload-dropped) *and* an operator panic button — all withholding clearance at
the same `marker_id` for independent reasons. ADR-002 named the single-gate case
("a station gates the platform marker for a dwell time; a crane-gated station
gates it until the crane reports payload-dropped") but never pinned down what
happens when two or more gate the same point at once. The unresolved question:
is clearance withheld while *any* gate withholds (conjunctive AND), or can a
higher-priority gate's grant *override* a peer's withhold (priority)?

The answer is largely already present in code, and worth ratifying explicitly so
authors can rely on it. The scheduler aggregates gate decisions in
`anyCapabilityDeniesClearance` (`packages/core/src/scheduler/scheduler.ts`):

```ts
for (const device of this.devices.values()) {
  for (const capId of device.capabilities) {
    const cap = this.registry.get(capId);
    if (!cap) continue;
    const state = device.capability_state.get(capId);
    const vote = cap.invokeOnClearanceConsultation(state, request);
    if (vote && vote.vote === 'deny') return true; // any deny vetoes
  }
}
return false;
```

Each `gates_clearance` device exposes its own `onClearanceConsultation` hook
(`packages/core/src/builtins/gates-clearance.ts`): it returns `deny` if the
proposed new limit marker is in its `withheld_markers`, otherwise `abstain`. The
scheduler folds these votes by **denying if any device denies**. The
`ClearanceVote` union (`packages/core/src/capability.ts`) is
`permit | deny | abstain`, but the fold currently only acts on `deny` — `permit`
and `abstain` both fall through to grant.

So multiple gates on one marker already compose as conjunctive AND: clearance is
extended only when *no* gate withholds. This is not an accident — it is what
"default state is stopped/safe" produces when the fold is a veto fold. This ADR
makes that the decided, named semantics rather than emergent behaviour, decides
the fate of the inert `permit` vote, and records what aggregate observability
does and does not yet exist.

## Decision

### 1. Multi-gate clearance is conjunctive AND; deny is absolute

When several `gates_clearance` devices gate the same marker, a train is cleared
across that marker only when **every** gate grants (i.e. none withholds). A
single withholding gate is sufficient to hold the train. This is the existing
veto fold, now a contract.

This is the only safe default under ADR-002. Each gate withholds for a reason
the others know nothing about — a dwell that hasn't elapsed, a crane payload not
yet dropped, an operator panic. Letting the train proceed while any of those
reasons stands would violate the very safety the gate exists to enforce. AND
means the strictest concurrent reason always wins, which is exactly what
"default stopped/safe" demands.

A `deny` vote is **absolute**: no other device's vote can cancel it. There is no
priority, no override, no "this gate outranks that gate."

### 2. Priority/override is explicitly rejected; `permit` carries no override power

The alternative — a high-priority gate whose `permit` overrides a peer's `deny`
— is rejected. Giving any single device the power to cancel another device's
safety veto is precisely the failure mode ADR-002 was designed to exclude:
movement would no longer require *all* relevant authorities to consent, only the
loudest one. A buggy or compromised "priority" gate could then drive a train
through a station whose crane is still mid-drop. The whole value of
clearance-not-commands is that the default is safe and every withholder is
respected; priority erodes that to nothing.

Consequently the `permit` vote carries **no override power** and stays reserved
and inert: returning `permit` is treated identically to `abstain` (it does not
veto, and it cannot un-veto a peer's `deny`). It remains in the `ClearanceVote`
union as a reserved value for a future explicit-consent semantics, should one
ever be designed and discussed — but today it is a no-op. Authors who return
`permit` expecting it to override a peer get a silent no-op; this ADR documents
that so the expectation never forms.

### 3. The fold is capability-generic, not gate-specific

The aggregation is a fold over `onClearanceConsultation` votes from *all*
capabilities, not over a "gate" device class. The scheduler never learns what a
gate is; it asks every capability with the hook and vetoes on any `deny`. A
satellite capability that needs to gate a marker for its own reason gets the same
AND composition for free, with no scheduler change. This keeps the decision
inside the capability system — there is no device-class-specific scheduler logic,
per the architectural commitment.

### 4. Observability: per-gate retained state is the aggregate; a scheduler-side
view is deferred

The honest aggregate today is the **union of per-gate state**, observable without
any new machinery:

- Each `gates_clearance` device publishes its own `withheld_markers` (with
  `reason` strings) in its retained `railway/state/devices/{id}` snapshot.
- Each gate emits `gate_state_changed` (`withholding` / `granting`) on every
  transition.

To answer "which gates are withholding marker X, and why," a subscriber reads the
retained state of each gating device and takes the union. Under AND this union is
complete: the marker is held iff that union is non-empty, order-independent.

What does **not** exist today is a single scheduler-emitted "marker X blocked by
[reasons]" snapshot. The scheduler's `anyCapabilityDeniesClearance` returns a
bool, **short-circuits on the first `deny`, and discards the deny `reason`**.
Surfacing an aggregated, scheduler-side reason list is a **deferred follow-up**:
it requires changing the fold from short-circuit-bool to collect-all-reasons and
retaining the discarded `reason` strings into a new retained topic (e.g.
`railway/state/gating/{marker_id}`). Because AND is order-independent,
short-circuit is a valid optimisation of the same fold — so this change is purely
for reporting and changes no clearance outcome.

### 5. Single-gate behaviour is unchanged

n=1 AND is bit-identical to the current single-gate path: one gate's `deny`
vetoes, its `abstain` grants. The existing
`packages/integration/src/gate-hold-release.test.ts` (operator
`hold_gate`/`release_gate` round-trip through a real `VirtualGate`) exercises
exactly this and is unaffected. This ADR adds AND semantics for n>1 without
touching the n=1 case.

## Consequences

- **Safe by construction.** The strictest concurrent withhold always wins; no
  device can override another's safety veto. A train held by two gates needs both
  to grant before it moves, and stays held if either is still withholding or
  vanishes mid-withhold.
- **Disconnect composes cleanly.** `gatesClearanceCapability.onDeviceDisconnect`
  releases only *that* device's withholds (it resets its own `withheld_markers`
  and emits a warning anomaly). Under AND a vanished gate therefore drops only
  its own veto; any peer gate still withholding the same marker keeps the train
  held. Per-device state plus AND gives this as a genuine safety property, not a
  special case.
- **Capability-generic, no scheduler regression.** The decision is a property of
  the vote fold, not of a gate device class. New gating capabilities inherit AND
  for free; the scheduler is untouched.
- **`permit` is reserved but inert.** Documented as a no-op today. If a future
  ADR ever introduces an explicit-consent or override semantics, it must be a
  flagged, discussed decision — `permit` is the reserved hook for it, deliberately
  doing nothing until then.
- **Deferred follow-up: aggregated gating view.** A scheduler-emitted
  per-marker "blocked by [reasons]" retained snapshot would let the visualiser
  show *why* a marker is held without subscribing to every gate. It needs the
  fold to collect-all and stop discarding `reason`; it is reporting-only and
  changes no clearance outcome. Out of scope here.
- **Multi-gate has no dedicated integration test yet.** A test spawning two
  `VirtualGate`s on one marker, asserting the train is held until both release
  and that disconnecting one while the other holds keeps the train stopped, should
  land with the follow-up (or alongside this ADR's acceptance) to lock the n>1
  guarantee the way `gate-hold-release.test.ts` locks n=1.
