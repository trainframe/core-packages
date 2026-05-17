# @trainframe/integration

Cross-package wire-level integration tests.

Each test file spins up an in-process [aedes](https://www.npmjs.com/package/aedes) broker on a random port, connects the real `@trainframe/server` to it via the production `mqtt` client, and acts as a "device + operator + visualiser" through the wire. Tests are written in user-action / observation language (`given … when … then …`) and exercise the protocol exactly as it works in production.

## What lives here

- Cross-package flows where the question is "do these packages compose correctly through the broker?"
- Examples: clearance flow end-to-end, retained-state bootstrap, multi-device interaction.

## What does NOT live here

- **Unit tests for individual packages.** Those stay in their own packages and use whatever in-process abstractions make them fast.
- **Browser-driven UI tests** of the visualiser or simulator UI. Those need a browser driver (Playwright) and live in a separate package whenever they're added — clicking real DOM, asserting on real SVG.

## Running

```sh
pnpm --filter @trainframe/integration test
```

Tests open real TCP sockets between the in-process broker and the server, so timeouts are looser than unit tests (10s default).

## Coverage

Coverage is intentionally disabled for this package. It IS the cross-cutting coverage; gating its own coverage on itself would be circular. Per-package coverage thresholds still apply to the things this package exercises.
