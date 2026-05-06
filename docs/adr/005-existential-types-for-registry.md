# ADR-005: Existential-types pattern for the capability registry

## Status

Accepted.

## Context

`Capability<State>` is generic in its State type. Different capabilities legitimately have different state shapes: `gates_clearance` tracks withheld markers, `controls_turntable` tracks rotation angle. The registry needs to hold them all together.

TypeScript, given a heterogeneous collection, has two options for the element type:

1. **`Capability<unknown>`.** Looks right, but breaks because functions are *contravariant* in their parameters. A `(state: { rotating: boolean }) => ...` is not a `(state: unknown) => ...`. TypeScript correctly rejects this.

2. **`Capability<any>`.** Opts out of variance checking *and* opts out of safety inside the registry. Casting through `any` would work but produces a codebase littered with unsafe assignments and silent type bugs.

Neither is acceptable. The first doesn't compile; the second violates the project rule of zero `any`.

## Decision

Use the existential-types pattern: a typed-author-facing `Capability<State>` and an untyped-registry-facing `RegisteredCapability`, with a single `wrap()` adapter between them.

```typescript
// What authors write
interface Capability<State> { ...typed... }

// What the registry stores
interface RegisteredCapability {
  initialiseStateFor(deviceId: string): unknown;
  invokeOnEvent(state: unknown, ctx: ...): { newState: unknown; intents: ... };
  // ...
}

// The single coercion site
function wrap<State>(cap: Capability<State>): RegisteredCapability {
  return {
    invokeOnEvent(state, ctx) {
      const result = cap.hooks.onEvent?.(state as State, ctx);
      // ...
    }
  };
}
```

The `state as State` cast inside `wrap()` is sound because every state value flowing back through `invokeOnEvent` originated from this same capability's `initialiseStateFor` (or a previous `invokeOnEvent` on the same capability). The registry never crosses state values between capabilities.

## Consequences

- Zero `any` in the codebase. Project rule satisfied.
- Authors write fully typed capabilities. Their hooks receive their actual State, not `unknown`.
- The registry is uniform: one method signature handles every capability.
- One small adapter function (`wrap`) is the entire variance management. Easy to audit.
- Other generic registries in the codebase should follow this pattern. Document it as the standard.
- The pattern requires understanding why naive `unknown` doesn't work. That's a learning curve, but the alternative (sprinkled `any`) is worse.
