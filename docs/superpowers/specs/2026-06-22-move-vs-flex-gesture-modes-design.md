# Move vs Flex — gesture modes for piece dragging

**Date:** 2026-06-22
**Status:** draft for review
**Extends:** `2026-06-22-authoritative-track-connection-design.md`

## Problem

The authoritative-connection rebuild made dragging a connected piece ALWAYS flex
(bounded ±5°/joint) and rubber-band, and NEVER separate. Watching a real session
exposed three things that fights the operator:

- **No removal.** Pulling a piece off a chain is impossible — it stretches and
  rubber-bands but never detaches. (The velocity yank-detach was removed and never
  replaced.)
- **Attach by carrying is impossible.** To join an open end to a separate piece's
  end you must *move* the end over — but flex makes the piece lag away from the
  target, and the gap stays well beyond the ~60mm flex-capture, so it never snaps.
- **Orphans can't be rejoined.** A loose piece can't be carried back onto an end.

Root cause: the bounded-flex-rubber-band model is the WRONG default for "pick a
piece up and move it." Flex should be an opt-in fine-adjustment, not the thing every
drag does. The earlier mistake was over-correcting an *uncontrolled* sever into
"never separate at all."

## Principle

**The interaction mode is chosen by the operator's gesture at the start of the
drag — never inferred from geometry (speed, reach, distance).** Geometry-inferred
modes are what made detach unpredictable. An explicit gesture + visible feedback
makes it discoverable and never surprising.

## The two gestures

### Move mode — click + drag (the default)
A press followed by movement (cursor leaves a small **deadzone** before the
flex-hold dwell elapses) picks the piece UP:

- The piece **detaches** from its chain and follows the cursor as a free placement
  (any piece — chained, ring member, or loose). The rest of the chain stays at its
  on-grid rest.
- On release it **snaps onto a nearby aligned open end** (proximity + anti-parallel
  heading within the join window) — that is the ATTACH — or drops where released
  (reposition / remove). Re-attach always works, so orphans are rejoinable.

### Flex mode — click + hold, then drag
A press that **stays within the deadzone for a short dwell (~250ms)** enters flex
mode:

- A **subtle blue ripple emanates outward from the held piece along its connected
  track** — the unambiguous "you are now flexing" affordance (distinct from the
  brighter closure wave that fires on a completed loop).
- Subsequent dragging **flexes** the chain within budget (the smooth bend), holding
  at max flex when the cursor outruns reach (rubber-bands). Flexing NEVER severs.
- On release: the bend is BAKED so a flexed length is POSABLE — it stays where it
  was bent, attached or not (a completed loop also fires the closure wave). This
  supersedes the earlier spring-back: the cross-drag compounding that forced
  spring-back is fixed at the solver — the absolute-budget clamp is now sign-correct
  (it bounds the EFFECTIVE deviation `cur + sign·δ`, where `sign` is the FK tree
  direction per joint), so every joint stays within ±FLEX_BUDGET_DEG of the grid
  across any number of flex/bake stints and a re-flexed posed chain never severs.

The discriminator is purely move-vs-hold at the *start*; the ripple confirms the
mode, so the operator never trips a flex limit into an accidental detach.

## Design

### Gesture state machine (`PieceRenderer` pointer handlers)
- `pointerdown`: record start point; `mode = 'pending'`; start a `FLEX_HOLD_MS`
  (~250ms) timer.
- `pointermove` while `pending`: if the cursor has moved beyond `DEADZONE_PX` (~6px),
  set `mode = 'move'` and cancel the timer; otherwise ignore (waiting).
- hold timer fires while still `pending` (cursor inside the deadzone): `mode = 'flex'`;
  fire the flex-mode ripple.
- `pointermove` in `move`: free-move callback. In `flex`: flex callback.
- `pointerup`: commit per mode.

The mode is reported to the parent so its handlers branch explicitly (no
`solveFollow`-returns-empty inference). Determinism: the hold timer must be testable
(inject a clock / fake timers — never `Date.now`).

### Move mode (parent)
Detach the dragged piece from its chain (drop its joints for the drag), follow the
cursor via the existing free-placement path, and on release reposition + snap
(`computeMovePlacement`, which already seats onto a nearby open end). Verify/widen
the snap so a carried end reliably joins an aligned target.

### Flex mode (parent)
Unchanged from the authoritative-connection spec: `solveFollow` against rest poses,
bounded, non-severing, spring-back or closure-bake on release.

### Flex-mode ripple (new visual)
A soft one-shot ripple from the held piece outward along the connected track on flex
entry. Reuse the wave renderer but visually distinct (softer/dimmer than the closure
wave). Stable clock (no `Date.now`/`Math.random` in render).

## Supersedes
- "Flexing never separates" no longer means "a drag never separates" — a plain
  (move) drag detaches BY DESIGN. Flexing (hold mode) still never severs.
- The criterion-1 regression from the prior goal ("a plain slow drag of curve-8 stays
  connected") is REVISED: a plain drag is now move mode (detaches). The non-sever
  guarantee moves to FLEX mode (hold, then drag → never severs).

## Testing strategy (carry forward the improved review)
1. Gesture discrimination unit test: a move-first drag enters move mode; a
   hold-then-drag enters flex mode (deterministic clock).
2. Move mode: dragging a chained piece detaches it; dropping it on an aligned open
   end attaches (one component grows); dropping in space leaves it free and
   rejoinable.
3. Flex mode: hold → ripple fires; dragging flexes within budget, never severs;
   repeated hold-flex cycles never compound (spring-back holds).
4. Attach reliability: carrying an end onto an aligned target within the window joins
   every time.
5. Adversarial agent on the running UI: try to make a move-drag fail to detach, a
   drop-on-aligned-end fail to attach, a flex-mode drag sever, or the wrong mode
   engage. CANNOT-REFUTE after genuine attempts.
6. A screen recording of the two gestures (yank a piece off; hold→flex→close),
   reviewed frame-by-frame by a second adversary.

## Success criteria
- `pnpm typecheck && lint && test` green; coverage floors held; zero `any`; Biome
  clean; each fix preceded by a failing test.
