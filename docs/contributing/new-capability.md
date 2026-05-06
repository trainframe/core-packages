# Building a new capability

A capability defines a new *kind of behaviour* that devices can declare. If you're building a new device that fits an existing capability (like `gates_clearance`), see [new-device.md](./new-device.md). This guide is for when you need a new capability, i.e. devices that participate in scheduling in a way the platform doesn't yet support.

The bar is high. Most "I need a new capability" situations turn out to be expressible with `gates_clearance` plus custom events. Before reading further, ask: can my device's behaviour be expressed as "withhold/grant clearance at marker X based on some condition"? If yes, you don't need a new capability.

If your device genuinely needs to participate in scheduling differently (say, by influencing route planning, or by reserving track segments outside the clearance model), then read on.

## What a capability is

A capability is a value implementing the `Capability<State>` interface from `@trainframe/core`. It defines:

- An identifier (`com.yourname.your_capability`)
- Custom event types it introduces beyond core events
- Custom command types it accepts
- A state schema describing the per-device state the platform tracks
- An initial state factory
- Hooks the scheduler invokes during decision-making

Capabilities are values, not classes. They are pure data plus pure functions. No I/O, no async, no `Math.random` or `Date.now`.

## Step 1: Decide the contract

Before writing code, decide:

- **What does this capability let a device do?** One sentence. If it takes more, it's probably two capabilities.
- **What hooks does it need?** Most capabilities use `onEvent` (to update state in response to events) and `onClearanceConsultation` (to vote on clearance grants). New hook surface is a protocol change requiring discussion.
- **What state per device?** As small as possible. State is per-device and persists across events.
- **What custom events and commands?** Define these in TypeBox schemas; the platform validates them at the broker boundary.

## Step 2: Implement

Create a TypeScript file exporting your capability:

```typescript
import { type Static, Type } from '@sinclair/typebox';
import type { Capability } from '@trainframe/core';

const MyState = Type.Object({
  // ...
});
type State = Static<typeof MyState>;

export const myCapability: Capability<State> = {
  id: 'com.yourname.my_capability',
  description: 'One-line description.',

  customEvents: [
    { event_type: 'my_custom_event', payloadSchema: Type.Object({ /* ... */ }) },
  ],
  customCommands: [
    { command_type: 'my_custom_command', payloadSchema: Type.Object({ /* ... */ }) },
  ],

  stateSchema: MyState,
  initialState: () => ({ /* ... */ }),

  hooks: {
    onEvent: (state, ctx) => {
      // Update state in response to events. Return new state and any intents.
      return { newState: state, intents: [] };
    },

    onClearanceConsultation: (state, request) => {
      // Vote on whether a clearance extension should proceed.
      return { vote: 'abstain' };
    },
  },
};
```

The hooks are pure functions. They receive state and context, return new state and intents. The scheduler invokes them; you never call them directly.

## Step 3: Test

Capabilities are easy to test because they're pure. Test the hooks directly:

```typescript
import { describe, it, expect } from 'vitest';
import { myCapability } from './my-capability.js';

describe('myCapability', () => {
  it('updates state when receiving my_custom_event', () => {
    const initial = myCapability.initialState('device-1');
    const result = myCapability.hooks.onEvent?.(initial, {
      device_id: 'device-1',
      event_type: 'my_custom_event',
      payload: { /* ... */ },
      device_capabilities: ['com.yourname.my_capability'],
    });
    expect(result?.newState).toEqual(/* expected new state */);
  });

  it('votes deny when consulted under condition X', () => {
    const state = { /* state under condition X */ };
    const vote = myCapability.hooks.onClearanceConsultation?.(state, {
      train_id: 'T1',
      current_limit_marker_id: 'M1',
      proposed_new_limit_marker_id: 'M2',
      proposed_edges_to_clear: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
    });
    expect(vote).toEqual({ vote: 'deny', reason: '...' });
  });
});
```

These tests validate behaviour without any infrastructure.

For end-to-end validation, write a simulator integration test:

```typescript
import { Simulation } from '@trainframe/simulator';
import { myCapability } from './my-capability.js';

it('end to end: my capability changes train behaviour', () => {
  const sim = new Simulation({
    layout: testLayout,
    extraCapabilities: [myCapability],
  });
  // ... drive the simulation, assert outcomes
});
```

## Step 4: Register at platform startup

Your capability is a value; the platform's startup code registers it:

```typescript
import { CapabilityRegistry, BUILTIN_CAPABILITIES } from '@trainframe/core';
import { myCapability } from '@yourname/trainframe-mycap';

const registry = new CapabilityRegistry();
registry.registerAll(BUILTIN_CAPABILITIES);
registry.register(myCapability);
registry.freeze();
```

Operators who want your capability install your package and add the registration line. You don't modify the core platform.

## Step 5: Ship

Publish your package on npm under your namespace. Document it. List it in the community registry (TODO when registry exists).

## When to propose a core capability instead

If your capability is general enough that many users would want it, propose it as a core capability. Open an issue describing the use case, examples of devices that would declare it, and the hook surface needed. The discussion will determine whether it goes into core or stays as a satellite.

The bar for core is: it generalises across multiple plausible device types, it doesn't conflict with existing capabilities, and someone will maintain it. Most capabilities don't meet this bar and are better off as satellites. That's not a slight; satellites are the ecosystem.
