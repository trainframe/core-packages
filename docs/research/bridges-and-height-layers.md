# Design research: bridges and multiple height layers

**Status:** research note — **partly implemented.** Option A's editor-side work
shipped: a discrete `layer` on `TrackPiece`, the ramp piece, layer-aware
clustering/snapping, and layer-ordered rendering. [ADR-025](../adr/025-n-level-toy-table.md)
then took it to *n* decks (supports, depth-scaled height cue, growable deck
selector) — still editor-only, graph height-free. **Open question #1 (height on
the wire, for the visualiser) remains undecided** and would still need a protocol
bump. The rest of this note is preserved as the original argument.

**Scope:** how Trainframe might support track that crosses *over* other track on
a different vertical level — bridges, ramps/inclines, stacked loops — on a
Brio-style table. Cited against the current code so the argument is concrete.

---

## TL;DR / recommendation

The logical graph (markers, edges, scheduler, clearance) needs **zero**
knowledge of height. Height is purely a spatial-layout concern. The thing that
actually makes a bridge "work" is *connectivity*, not a `z` value: a bridge is
the case where two pieces of track cross in 2D projection but must **not** share
a marker, so two trains can pass at the same `(x, y)` without conflict. A flat
`crossing` is the opposite: it deliberately compiles to *one* shared marker, so
the two paths mutually exclude.

The leanest design (Option A below) is therefore:

- Add a discrete `layer` index to the editor's `TrackPiece` and (optionally) to
  the spatial `position` on `LayoutMarker`. Default layer `0`.
- Add a ramp/incline piece that *changes* layer between its two ends.
- Make endpoint clustering and placement snapping **layer-aware**, so two
  endpoints at the same `(x, y)` on different layers never merge.
- Leave `packages/core` (scheduler, layout-state, clearance) completely
  untouched. It already reasons only in markers and edges.
- Keep rendering 2D top-down, drawing pieces in layer order with a small
  shadow/gap on the under-track so the over/under read is legible.

ADR-011 already anticipates exactly this pattern for a "real crossover" — see
[citation below](#the-section-rule-is-the-whole-story) — so this is an
extension of existing accepted thinking, not a new direction.

---

## 1. What "bridge / multiple height layers" means physically

On a Brio table, the relevant physical cases are:

- **Bridge / overpass:** one track is raised on piers so a second track passes
  *underneath* it. At the crossing point the two tracks share an `(x, y)`
  footprint but no rail — a train on the top deck and a train on the bottom
  pass simultaneously with no interaction.
- **Ramp / incline:** a sloped piece that carries track from one height to
  another (ground level up onto the bridge deck, or down again). Brio sells
  graduated risers; logically the ramp is just a length of track whose two ends
  sit on different layers.
- **Stacked loops / spirals:** a whole loop (or helix) sitting above another
  loop, joined by ramps. Several discrete heights, each a flat plane, connected
  vertically only through ramps.

### How this differs from the existing `crossing` piece

The existing `crossing` is a **same-plane diamond X**: two straights meeting at
90° in one plane, four endpoints (east/north/west/south), all at the same
height (`pieces.ts:228-235`, `crossingShape()` at `pieces.ts:384-392`). Two
trains on opposite diagonals would physically share rail at the centre.

The compiler makes this safe by giving the whole piece **one** marker. Markers
are one-per-piece, id `M-{piece.id}` (`layout-from-pieces.ts:121`, emitted in
`emitMarkers` at `layout-from-pieces.ts:214-230`), and all four neighbours snap
onto endpoints of that single piece, so every path through the X is incident to
the *same* marker. Under the section rule that means mutual exclusion (see §3).

A true bridge is the inverse: same 2D footprint, but the two tracks must be
**topologically independent** — no shared marker, no shared section, both trains
proceed. So the distinction "crossing vs bridge" is fundamentally a *graph
connectivity* distinction (one node vs two disjoint paths), and only
*incidentally* a height distinction. Height is how a human authors and reads it;
disjoint connectivity is what makes it correct.

> Side note (not a rabbit-hole, just supporting evidence): because
> `emitEdgesForCluster` connects *every* ordered pair of pieces in a cluster
> (`layout-from-pieces.ts:161-177`), the current flat `crossing` actually emits
> edges for *all* incident pairs — including north→`M-crossing`→east "turns",
> not just straight-throughs. The scheduler is still collision-safe (one shared
> marker), but the X today is over-connected as a turn-table rather than a true
> diamond. This reinforces the bridge thesis: a bridge wants *two* independent
> straight paths, which both avoids the false serialisation *and* avoids the
> false turns. (Tightening the flat crossing's edge set is a separate concern;
> don't fold it into the bridge work.)

---

## 2. How the current 2D spatial model represents position and connectivity

There are two `position` concepts and they are both strictly 2D today.

**On the wire (protocol).** `LayoutMarker.position` is an *optional*,
explicitly-presentational `{ x_mm, y_mm }` (`layout.ts:13-25`):

```
/** Optional 2D position for the visualiser; ignored by the scheduler. */
position: Type.Optional(Type.Object({ x_mm: Type.Number(), y_mm: Type.Number() }))
```

`LayoutEdge` (`layout.ts:27-36`) carries *no* geometry at all — only topology
plus learned `estimated_length_mm`. `Layout` is `{ name, markers, edges,
junctions }` (`layout.ts:49-54`). There is no `z`, no `layer`, no elevation
anywhere in the protocol.

**In the editor (sim-ui).** `TrackPiece.position` is `{ x, y }` plus a
`rotationDeg` constrained to 45° multiples (`pieces.ts:74-90`). Endpoints are
computed in 2D world space (`getEndpoints` at `pieces.ts:254-269`); the
`TrackEndpoint` is `{ x, y, outgoingAngleDeg }` (`pieces.ts:92-97`). Again, no
height anywhere.

**Connectivity** is derived purely from 2D proximity. `compileLayout`
(`layout-from-pieces.ts:256-263`) collects every endpoint, clusters endpoints
within `SNAP_DISTANCE_MM = 30` (`layout-from-pieces.ts:10`, clustering at
`:23-75`), and emits a directed edge between any two distinct pieces whose
endpoints landed in the same cluster (`:161-192`). Placement snapping uses the
same 2D Euclidean test (`placement.ts:42-44, 67-73, 108-123`,
`CONNECT_CAPTURE_MM = 60` at `:25`).

### What would need to extend to express height

Concretely, the minimal set:

1. **A `layer` on `TrackPiece`** (`pieces.ts:76-90`). A small non-negative
   integer (`0` = ground). This is the editor's source of truth for "which deck
   is this piece on." Default `0` so all existing layouts are unchanged.
2. **A ramp piece type** added to `TrackPieceType` (`pieces.ts:12-21`) plus its
   `localEndpoints` (`pieces.ts:184-243`) and shape (`pieces.ts:284-305`). A
   ramp's two ends belong to *different* layers — it is the only piece that
   bridges layers. (Whether the layer transition is a property of the piece or
   of its two endpoints is an open question, §6.)
3. **`layer` (or `z_mm`) on the spatial `position`** in `layout.ts:17-22` —
   *optional*, still presentational, still ignored by the scheduler. Needed only
   if the visualiser (`@trainframe/visualiser`, a separate MQTT subscriber that
   never sees the editor's `TrackPiece`) must draw over/under correctly. See §4.

Note the deliberate asymmetry: the *editor* needs `layer` to author and snap
correctly; the *protocol* needs it only if the system-view visualiser must
render height. The choice between "discrete `layer` int" and "continuous
`z_mm`" is the main spatial design axis (Options A vs B, §5).

---

## 3. Does the LOGICAL graph need to know about height? (the crux)

**No. Height is entirely a spatial-layout concern. Argued below.**

This is the central question given the spatial-vs-logical separation commitment
(CLAUDE.md "Architectural commitments"; spec §"Topology" at
`protocol-v0.2.md:193-213`, which states plainly "the logical graph is
authoritative; spatial layout is presentational").

### The scheduler is already height-blind

The core reasons only in markers and edges. Every use of the word "position" in
`packages/core/src/scheduler/*` refers to **switch position** (junction state)
or **route/train position**, never spatial coordinates — verified across
`layout-state.ts`, `scheduler.ts`, `planner.ts`. `LayoutState`
(`layout-state.ts:35-59`) stores `markers`, `outgoingEdges`, `incomingEdges`,
`switchPositions` — no geometry. The planner is "purely structural"
(`planner.ts:11`). Clearance and conflict detection operate on marker identity
only (ADR-011 conflict check, below). Nothing in core consumes
`LayoutMarker.position`; it is already optional and already ignored.

### The section rule is the whole story

The discriminating fact lives in **ADR-011** (`docs/adr/011-...md`), which
defines a section as *an edge plus its two boundary markers*, and the rule:

> Two sections conflict when they share *any* boundary marker, not when they
> have the same identity. (ADR-011:40-42; conflict check at ADR-011:44-60;
> mirrored in `scheduler.ts` around the `edgeConflictsWithAnother`/boundary
> logic.)

From this single rule:

- **Flat crossing → one marker → mutual exclusion.** "Every X-incident edge
  shares X ... As soon as one train holds any of them, the rest are denied"
  (ADR-011:70-73). Correct for a same-plane diamond.
- **Bridge → two markers (one per deck) → no conflict.** ADR-011 already wrote
  down the fix for a real crossover, verbatim:

  > On a *physical* layout with a true crossover piece (where two tracks pass
  > through the same spatial point without sharing metal — common in Brio
  > sets), this rule incorrectly serialises. The model fix isn't to loosen the
  > rule but to author the crossover as **two separate markers** at the same
  > `x_mm,y_mm`, one for each track, connected only to its own loop. With no
  > shared marker, no shared section, no conflict. (ADR-011:89-96)

A bridge is the height-stacked instance of exactly that: two tracks sharing an
`(x, y)` footprint, authored as two markers on separate layers, connected only
to their own loops. The scheduler stays innately safe **and** never learns what
a layer is. Height is the human-facing authoring convenience (and the rendering
input) that *produces* the right disjoint connectivity; the graph only ever sees
the disjoint connectivity.

**Conclusion:** keep height out of `packages/protocol`'s logical graph and out
of `packages/core` entirely. The only protocol change worth considering is an
optional, presentational `layer`/`z_mm` on the *spatial* `position` (§4), and
even that is optional.

---

## 4. Implications

### Snapping / placement (load-bearing)

The "two pieces at the same `(x, y)` on different layers must NOT auto-connect"
requirement falls out directly from making the proximity metric **layer-aware**
in exactly two places. Today both use pure 2D Euclidean within 30 mm, so a
bridge deck endpoint sitting directly above a ground endpoint would *wrongly*
merge into one cluster (and one marker — the very thing a bridge must avoid).

- **Compiler clustering:** `collectEndpoints` (`layout-from-pieces.ts:23-36`)
  and `findNearbyCluster`/`clusterEndpoints` (`:43-75`). Gate the distance test
  (`:52-55`) so endpoints only cluster when they share a layer.
- **Editor placement:** `isCoincidentWithAnother` (`placement.ts:67-73`),
  `openEndpoints` (`:81-84`), `nearestOpenEndpoint` (`:108-123`), and
  `bestEndpointPair` (`:193-211`). Same layer gate, so a piece being dropped on
  layer 1 ignores layer-0 joints beneath it.

The ramp is the *only* piece whose two ends are on different layers, and so the
only place a cross-layer connection is legitimately allowed — its endpoints must
each carry their own layer, and the snap rule must permit layer-N to connect to
the ramp's layer-N end. This is the one subtlety the layer gate has to get
right.

### Edge generation

No structural change beyond the layer gate above. Once clustering is
layer-aware, `emitEdgesForClusters` (`layout-from-pieces.ts:179-192`) and
`emitDirectedEdge` (`:143-159`) already do the right thing — they produce
disjoint edge sets for the two decks because the endpoints never shared a
cluster. `estimated_length_mm` is centre-to-centre Euclidean (`:125-129`); a
ramp's 2D-projected length under-counts the true sloped length slightly, but
since real lengths are *learned* (spec `protocol-v0.2.md:213, 225`) this is
cosmetic, not a correctness issue.

### Rendering

Three rendering postures, increasing in cost:

- **2D top-down with layer-ordered draw (recommended).** Both the editor
  `ToyTable` (`ToyTable.tsx:1112-1134`, plain `pieces.map` with no z-sorting
  today) and the visualiser `LayoutCanvas` draw in array order. Draw lower
  layers first, higher layers last (a stable sort by `layer`), and add a small
  shadow / break-the-under-rail gap where an upper piece overlaps a lower one so
  the over/under read is legible. Cheap, fits the existing SVG pipeline. The
  visualiser's `computeMarkerPositions` (`LayoutCanvas.tsx:522-538`) and
  `scaleSpatialPositions` (`:540-567`) currently key only on `x_mm/y_mm`; they'd
  need the `layer`/`z_mm` to choose draw order and to nudge stacked markers so
  two markers at the same `(x, y)` don't render exactly on top of each other.
- **Isometric.** A fixed-angle projection (`screenY = y - z*k`) gives an
  immediate height read with no real 3D. Moderate cost: every piece/marker/train
  transform changes; the editor's click-to-world maths (currently a flat
  inverse) gets fiddlier.
- **Full 3D.** Highest fidelity, highest cost; new render tech, out of step with
  "keep it simple, 2D, JSON over the wire." Not recommended near-term.

---

## 5. Design options

### Option A — Discrete `layer` index, graph height-free *(recommended)*

- `layer: number` (default 0) on `TrackPiece`; optional `layer` on the spatial
  `position` in `layout.ts` for the visualiser.
- A ramp piece whose two ends differ by one layer.
- Layer-aware clustering + snapping.
- `packages/core` untouched. Rendering stays 2D top-down with layer-ordered draw.

**Pros:** matches Brio physical reality (discrete decks, not arbitrary heights);
smallest change; scheduler untouched; directly realises the ADR-011 crossover
pattern; minimal/zero protocol change. **Cons:** can't express a gentle
continuous gradient or a true helix mid-rise (each "level" is a flat plane);
ramp length under-counts (cosmetic).

### Option B — Continuous `z_mm`

- `z_mm` on positions/endpoints; ramps carry a real gradient; snapping is 3D
  proximity.

**Pros:** physically faithful; supports helices/spirals naturally. **Cons:**
heavier protocol surface; snapping must reason in 3D (now you genuinely need
isometric or 3D rendering to author it usefully — picking a joint in stacked 2D
becomes ambiguous); more wire data for a presentational concern. Over-built for
a Brio table whose risers are quantised anyway.

### Option C — Dedicated composite "bridge piece"

- A single piece type that *is* the overpass: it owns the upper span and the
  pier footprint, and the lower track simply passes through its bounding box.

**Pros:** one drag places a recognisable bridge; no per-piece layer bookkeeping
for the common case. **Cons:** least flexible (fixed geometry; no stacked loops,
no custom ramps, no spirals); still needs the layer/snap machinery underneath to
stop the lower track merging into it; risks a special-case piece that doesn't
compose with the rest of the track kit. Could be added *on top of* Option A
later as a convenience macro.

### Recommendation

**Option A.** It's the minimal extension that is physically honest for Brio,
keeps the spatial-vs-logical separation intact (scheduler/clearance see only the
disjoint connectivity, never a height), and is already blessed in spirit by
ADR-011's crossover note. Rendering stays in the existing 2D SVG pipeline with a
layer-ordered draw and an over/under shadow. Option C can be layered on later as
a one-click convenience; Option B's continuous heights are deferred to an open
question.

---

## 6. Open questions

1. **Layer on the wire, or editor-only?** If the system-view visualiser must
   render over/under, `layer`/`z_mm` belongs on `LayoutMarker.position`
   (`layout.ts:17-22`) → a protocol bump (workflow step 1: spec + version
   first). If we accept that the visualiser may draw stacked markers ambiguously
   for now, layer can live *only* in the editor's `TrackPiece` with zero
   protocol change. Decide before touching schemas.
2. **Where does the layer transition live — on the ramp piece or on its
   endpoints?** A ramp connects layer N to layer N+1; cleanest is probably a
   per-endpoint layer so the snap rule is uniform ("connect only same-layer
   endpoints") and the ramp is the one piece whose two endpoints differ.
3. **`SNAP_DISTANCE_MM` for vertically-stacked endpoints.** With pure 2D
   proximity, a deck endpoint directly above a ground endpoint is 0 mm away in
   plan. The layer gate must run *before* the distance test, not as a tiebreak,
   or stacked joints still merge. Confirm the gate placement in both
   `clusterEndpoints` and `openEndpoints`.
4. **Ramp gradient / length fidelity.** Acceptable to keep 2D-projected
   `estimated_length_mm` (learned anyway) or do we want the true sloped length?
   Likely cosmetic; flag only.
5. **Junctions across layers.** Does a powered switch ever sit on a ramp or
   span a layer change? Probably disallow (junctions stay within one layer);
   confirm.
6. **Rendering posture.** 2D layer-ordered draw now; revisit isometric only if
   operators report they can't tell which deck a piece is on. Full 3D is out of
   scope.
7. **Editor click-to-world with layers.** Clicking in stacked 2D is ambiguous
   (which deck did the operator mean?). Need an "active layer" selector in
   `ToyTable` so placement targets one deck at a time, mirroring how real layout
   software handles levels.

---

## Files cited

- `packages/protocol/src/layout.ts` — `LayoutMarker.position` (2D, optional,
  presentational), `LayoutEdge` (topology only), `Layout`.
- `packages/simulator-ui/src/track/pieces.ts` — `TrackPieceType`, `TrackPiece`,
  `crossing` endpoints/shape, `getEndpoints`.
- `packages/simulator-ui/src/track/layout-from-pieces.ts` — `SNAP_DISTANCE_MM`,
  clustering, per-piece markers, edge emission.
- `packages/simulator-ui/src/track/placement.ts` — 2D snapping / coincidence.
- `packages/core/src/scheduler/{layout-state,scheduler,planner}.ts` — purely
  topological; "position" only ever means switch/route position.
- `packages/visualiser/src/components/LayoutCanvas.tsx` — 2D SVG render, marker
  position from `x_mm/y_mm`.
- `packages/simulator-ui/src/components/ToyTable.tsx` — editor render, no
  z-sorting.
- `docs/spec/protocol-v0.2.md` §"Topology" — logical authoritative, spatial
  presentational.
- `docs/adr/011-section-as-edge-plus-boundary-markers.md` — the section rule and
  the crossover-as-two-markers precedent (lines 70-96).
