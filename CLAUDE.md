# Context for Claude

This file is read at the start of every Claude Code session. The rules here are not suggestions; they are the working contract for this codebase. If a rule conflicts with a request, raise the conflict before proceeding.

## What this project is

A capability-based protocol and platform for smart model railways. Any Brio-compatible track piece can join the network with appropriate hardware. Third parties define new device classes and capabilities without modifying the core. MQTT for transport. TypeScript for non-embedded code, Rust planned for firmware.

## Working practices — non-negotiable

### Never use `any`

The codebase contains zero `any` types. None. Not in casts (`as any`), not in generics (`<any>`), not in suppressions (`noExplicitAny: off`).

When TypeScript's variance fights you, the answer is the existential-wrapper pattern, not `any`. See `packages/core/src/capability.ts` — `Capability<State>` is what authors write, `RegisteredCapability` is what the registry stores, `wrap()` is the single sound coercion point. Follow this pattern when adding new generic registries.

If you genuinely cannot avoid an unsafe cast, the cast goes inside one well-named adapter function with a comment explaining why it is sound, and the rest of the code stays type-safe. Never sprinkle casts.

Before claiming a problem requires `any`, ask. The answer is almost always "no."

### Integration tests over mocking

Tests follow the Kent C. Dodds philosophy. The default is to test through the real seams: real broker (in tests, in-process via aedes or the in-memory client; in dev, Mosquitto), real scheduler, real registry, real physics devices. `startPhysicsEnv` in `@trainframe/simulator` was specifically designed to make this cheap.

A test that mocks the scheduler, the registry, or the capability hooks is testing implementation. Rewrite it to drive the system through events and observe outcomes.

The only acceptable inspection of internal state in tests is when the same observation cannot be made externally — and even then, prefer adding a public observer method to the appropriate class over reaching into private fields.

A typical good test looks like (from `packages/integration/src/multi-gate-clearance.test.ts`):

```typescript
const env = startPhysicsEnv(
  straightLoop(
    [
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'block_boundary' },
      { id: 'M4', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'multi-gate-clearance' },
  ),
);
const gate = env.spawnGate('GATE-A', { markers: ['M3'] });
gate.hold('M3', 'closed');
env.spawnTrain('T1', { atMarker: 'M1' });
env.assignSchedule('T1', ['M1', 'M3']);
env.advance(4000);
expect(
  env.commandsFor('T1').filter((c) => c.payload.limit_marker_id === 'M3'),
).toHaveLength(0);
```

Drive the system; observe the events and commands; assert on outcomes. No hook stubbing, no scheduler internals.

### Coverage thresholds are floors, not goals

Each package has coverage thresholds in its `vitest.config.ts`. They run in CI and they fail the build below threshold.

These numbers ratchet up over time. **Never lower a threshold to match a regression.** If a test legitimately can't be written for a piece of code (defensive branches that exist for type narrowing, etc.), exclude that line or file in the config with a comment explaining why.

Current thresholds:
- `protocol`: 90% lines, 85% branches
- `core`: 95% lines, statements and functions, 87% branches
- `simulator`: 80% lines, 75% branches
- `server`: 75% lines, 65% branches

When you add code, add tests. When tests pass but coverage drops, you haven't covered your new code; fix it before opening the PR.

### Biome must be clean

`pnpm lint` must produce zero errors and zero warnings before any commit. CI enforces this.

Do not suppress rules with `biome-ignore` to make a deadline. If a rule fires, either fix the code or, if the rule is genuinely wrong for this codebase, change it in `biome.json` with a comment explaining why and verify the change with the user.

`pnpm lint:fix` handles the auto-fixable errors. The non-auto-fixable ones (cognitive complexity, etc.) are real signals — refactor.

### TypeScript strictness

The project uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Don't loosen these. They catch real bugs.

`noUncheckedIndexedAccess` means `arr[0]` is `T | undefined`, always. Either narrow with a length check or use destructuring with default. Don't use non-null assertion (`!`) to "fix" it; that's lying to the compiler.

`exactOptionalPropertyTypes` means `{ x?: T }` and `{ x?: T | undefined }` are different. The first cannot accept `undefined` as a value; the second can. If you need to clear an optional field, the type must include `undefined` explicitly. Don't use `delete`.

### Architectural commitments

These are decided. Don't propose changes without explicit user discussion.

- **MQTT for application transport.** Not WebSocket-direct, not gRPC, not REST.
- **Capability-based extensibility.** Devices declare capabilities; the server schedules by capability. Built-in capabilities use the same public API satellites do.
- **Trains as autonomous agents.** Routes are assigned and executed locally. The server intervenes by modifying plans or withholding clearance, not streaming commands.
- **Clearance, not commands.** "Stop" is expressed as withholding clearance. Default state is stopped/safe.
- **Edge-based routes.** Routes are sequences of `{ from_marker_id, to_marker_id }` edges, not flat marker lists.
- **Spatial layout separated from logical graph.** Scheduler operates on the logical graph; visualisers consume the spatial layout. Keep them separate.
- **Simulator as a peer of hardware.** The simulator runs against the real broker, real server, real visualiser. Application code cannot tell virtual from physical.
- **JSON over the wire.** CBOR may come later as a wire optimisation transparent to the application protocol. Don't reach for binary formats early.

### Capability hooks must be pure

`(state, event) → (newState, intents)`. No I/O. No `Math.random`. No `Date.now`. No async. No thrown errors except for genuine programmer errors.

Side effects happen in the scheduler, which translates intents into effects, which the platform layer enacts. This separation is what makes the system testable and deterministic.

### Determinism in the simulator

The simulator is deterministic: the physics world steps at a fixed 60 Hz and every clock and id source is injected. `startPhysicsEnv` wires the server's `now`, the devices' `now` and `newId`, and the world step to one virtual clock, and tests advance it with `env.advance(ms)`. There is no seeded random source. If a test is flaky, either the simulator has a non-determinism bug (find it) or the test is making assumptions about output that aren't guaranteed (rewrite).

Never use `Math.random()` or `Date.now()` directly inside the simulator or scheduler. Take an injected `now` and `newId` instead (`Scheduler` takes `now`, `Server` takes both, devices and platforms take an `EnvelopeSource` from `packages/simulator/src/envelope-source.ts`). `deterministicEnvelopeSource` backs tests, and `packages/simulator/src/envelope.ts` validates every envelope through one adapter. The real clock and `randomUUID` appear only at the composition edge (`wallClockEnvelopeSource` in the toy table's entry point, and the `Server` defaults in `packages/server/src/server.ts`).

## File and package layout

This repository is `trainframe/core-packages` — the core bundle. The `-packages` suffix signals "monorepo of related packages that constitute the core" and distinguishes the repo name from the `@trainframe/core` npm package inside it.

Other repositories under the `trainframe` org follow these conventions:
- Satellite capabilities and devices: `trainframe/<short-name>` (e.g. `trainframe/turntable`, `trainframe/ble-bridge`). No `-packages` suffix even if they contain multiple packages — the suffix is reserved for the core bundle.
- Hardware reference designs, firmware, and physical artefacts: `trainframe/hw-<name>` if they don't contain code packages, or just `trainframe/<name>` otherwise.

Inside this repo:

- `packages/protocol/`: schemas, types, topic helpers, the TCF compact codec. Pure data shapes. No I/O. No business logic.
- `packages/core/`: capability registry, scheduler, layout state, clearance logic. Pure logic. No I/O.
- `packages/server/`: composition: broker client + scheduler + admin HTTP API + LearnMode, plus the `tf-server` CLI. The thin shell that turns logic into a running thing.
- `packages/simulator/`: the ADR-030 physics world (`PhysicsWorld`, rail networks, track pieces) and the devices that run on it, speaking the protocol identically to hardware. Provides `startPhysicsEnv`, the test harness.
- `packages/simulator-ui/`: the toy table: a browser virtual Brio table that runs the physics world and talks to a real server over MQTT.
- `packages/visualiser/`: web UI subscribing to MQTT; the operator's system view.
- `packages/ui-kit/`: shared UI primitives (Button, Panel, Drawer, themes). Depends on neither app.
- `packages/integration/`: cross-package tests: in-process aedes broker, real server, real physics devices.
- `packages/ui-tests/`: Playwright end-to-end tests against the toy table and visualiser.
- `examples/` — sample satellite packages.
- `docs/spec/` — protocol and simulator specifications, versioned.
- `docs/adr/` — architecture decision records.
- `docs/contributing/` — guides for new device types and capabilities.

When adding a feature, ask: does this go in protocol (data shape), core (logic), or somewhere else (composition/IO)? If it doesn't fit cleanly, the design is probably wrong; raise it.

## Workflow for changes

1. **Protocol changes first.** If the change touches the wire format, update `docs/spec/` and bump the protocol version before any code.
2. **Schemas next.** Add or update TypeBox schemas in `packages/protocol/`.
3. **Logic in core or as a satellite capability.** Don't add device-specific logic to the scheduler; express it as a capability.
4. **Tests alongside.** Integration tests in `packages/simulator/`, unit tests in the package being changed.
5. **Verify locally.** `pnpm typecheck && pnpm lint && pnpm test`. CI runs the same and blocks merging on any failure.
6. **Update ADR if the decision is significant.** A new ADR for any choice you'd want to remember the reasoning for in six months.

When fixing a bug:
1. Write the failing test first.
2. Make it pass.
3. Don't delete or weaken the test afterward.

## What not to do

- Don't add `any` — see above.
- Don't bypass the capability system to add device-class-specific logic to the scheduler. If it can't be expressed as a capability, the design is wrong; raise it.
- Don't put business logic in `packages/protocol/`.
- Don't write tests that mock the scheduler, registry, broker, or capability hooks.
- Don't suppress Biome warnings to ship faster. Fix them.
- Don't lower coverage thresholds to ship faster. Add tests.
- Don't introduce new transport protocols, message formats, or schema systems without discussion.
- Don't use `Math.random()` or `Date.now()` in core or simulator code.
- Don't use `delete` on object properties; use `undefined` assignment with proper optional types.

## Open design questions

These are unresolved; ask before assuming an answer. Conflict resolution (ADR-017), multi-gate semantics (ADR-018), topology violations (ADR-019), the ESP-NOW wire format (ADR-021), coupling (narrowed to train length in ADR-023) and tag to marker resolution (ADR-007) are decided.

- Station dwell is a scheduler constant (`STATION_DWELL_MS`), not a capability or a per-stop setting
- Heartbeat versus duty cycle: a sleepy ESP-NOW loco cannot publish `train_status` every tick, so cyclic-schedule dwell resume (ADR-028) needs an explicit trigger (ADR-035)
- Composite-parent association: a zone or depot gathering its children's device associations has no lifecycle yet (ADR-035)
- Stopping at a marker: distant plus home pattern, or single marker with calibrated overshoot
- Route plans with conditional branches; routes are linear edge sequences
- Broker authentication and device pairing at the broker
- Sensor noise and mishap injection (ADR-006) in the physics world

## Useful references

- `docs/spec/protocol-v0.2.md` — current protocol spec (protocol version 0.15.0)
- `docs/status.md` — what is built, partial or missing, per package
- `docs/spec/simulator-v0.1.md` — simulator architecture (physics world, `startPhysicsEnv`)
- `docs/contributing/new-device.md` — how to build a new device type
- `docs/contributing/driving-the-ui-live.md` — playbook for live-driving the
  simulator-ui and visualiser through a controllable browser (Chrome DevTools
  MCP, headed Playwright, manual). Read this *before* opening browser tabs
  for a multi-step journey — it captures the gotchas (isolated contexts,
  `localhost` vs `127.0.0.1`, broker port conflicts, controlled-input
  setters) that otherwise cost real time.
- `docs/adr/` — decisions and reasoning

## When in doubt

Ask. The user prefers a clarifying question to a wrong implementation. Especially when you're about to:
- Add a new dependency
- Change a protocol shape
- Loosen a type or a lint rule
- Lower a coverage threshold
- Add a `biome-ignore` comment
- Mock something in a test
- Add a new top-level package
