# Driving the UIs live

Playbook for interactively driving the simulator-ui and visualiser through a
controllable browser — typically Chrome via the `chrome-devtools` MCP server
in Claude Code, but the principles apply to anything that automates a real
browser (Playwright UI mode, headed runs, manual). The point is to set up
a journey end-to-end (custom track, multiple trains, gates, the lot) without
re-discovering the hard-won lessons every time.

If you're writing a Playwright **spec** instead, the model is
`packages/ui-tests/tests/multi-train-journey.spec.ts` and the shared helpers
at `packages/ui-tests/src/playwright-helpers.ts`. The principles below
overlap, but specs run against the test harness; this doc is for driving the
real dev servers + the real broker.

---

## Pre-flight

The two UIs and the broker have to be reachable before there's any point
opening a browser:

```sh
# Dev servers — pick any free ports. The repo's vite configs default to
# 5174 (sim-ui) and 5173 (visualiser); if another project owns those, the
# vite CLI accepts --port and --strictPort.
pnpm --filter @trainframe/simulator-ui dev --port 5274 --strictPort
pnpm --filter @trainframe/visualiser    dev --port 5273 --strictPort

# Broker — Mosquitto in a container is fine; the user has mosquitto
# bound to 1883 + 9001 via podman.
podman start trainframe-broker
nc -z 127.0.0.1 9001 && echo "broker WS up"
```

Two gotchas that cost real time:

- **Use `localhost`, not `127.0.0.1`, in URLs you hand the browser.** Vite
  binds to `localhost`, and `curl 127.0.0.1:5273` returns HTTP 000 even
  though `curl localhost:5273` returns 200. Same hostname-resolution rule
  applies to the page goto inside DevTools MCP.

- **The Playwright ui-tests harness binds the same broker port (9001) the
  dev UIs use.** If you've been live-driving and then run the spec suite,
  the harness can't bind. Stop the user's broker first
  (`podman stop trainframe-broker`) and restart after.

---

## Open both UIs in **separate** browser contexts

This is the single most important rule. The visualiser and the simulator-ui
both write to `localStorage` (`trainframe.visualiser.brokerUrl`,
`trainframe.simulator-ui.layout`, etc). If you open both in the same
browsing context they'll trample each other's settings and you'll spend
half the session chasing ghosts.

With `chrome-devtools` MCP:

```
mcp__chrome-devtools__new_page
  url: http://localhost:5273/
  isolatedContext: visualiser

mcp__chrome-devtools__new_page
  url: http://localhost:5274/
  isolatedContext: simulator-ui
```

Each `isolatedContext` value gets its own profile + storage. Use distinct
names — they can be anything memorable, just *not the same string*.

If `new_page` fails with `"The browser is already running for ... chrome-profile"`,
a previous session left a Chrome alive:

```sh
pkill -9 -f "chrome-devtools-mcp/chrome-profile"
rm -f ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock
```

then retry.

---

## Driving the UIs

Three ways to interact, in order of preference:

1. **Semantic clicks via `take_snapshot` + `click {uid}` + `fill {uid}`.**
   `take_snapshot` returns a structured a11y tree with `uid` per element.
   Click and fill by uid. Works for most flows. Cheap.

2. **`evaluate_script` for rich state assertions or DOM-level peeking.**
   When the snapshot tree gets large (the event log fills to ~100 entries
   and dominates the output), a targeted `evaluate_script` is far smaller
   and gets you exactly the field you want:
   ```js
   () => ({
     status: Array.from(document.querySelectorAll('dt'))
       .find(dt => dt.textContent === 'Status')
       ?.nextElementSibling?.textContent,
     trains: Array.from(document.querySelectorAll('[data-train-id]'))
       .map(el => ({
         id: el.getAttribute('data-train-id'),
         onEdge: el.getAttribute('data-on-edge'),
         atMarker: el.getAttribute('data-at-marker'),
       })),
   })
   ```

3. **`evaluate_script` to *set* controlled-input values when `fill` doesn't
   take.** React controlled components sometimes reject a plain `fill`
   because the underlying `value` setter is shadowed by React. Use the
   native setter + dispatch the right event:
   ```js
   const setter = Object.getOwnPropertyDescriptor(
     HTMLInputElement.prototype, 'value'
   ).set;
   setter.call(input, 'T1');
   input.dispatchEvent(new Event('input', { bubbles: true }));
   ```
   Same pattern for `HTMLTextAreaElement` and `HTMLSelectElement` (the
   select event is `change`, not `input`).

---

## Selectors / data attributes you'll reach for

The visualiser exposes these on rendered SVG so tests can locate them
semantically. They're the right things to assert on for live driving too:

| Attribute | On | Means |
| --- | --- | --- |
| `[data-marker-id="M2"]` | `<g>` group around a marker | The marker exists in the rendered layout |
| `[data-train-id="T1"]` | `<g>` group around a train icon | The visualiser knows about this train |
| `data-at-marker="M3"` | on the train `<g>` | Last `marker_traversed` placed it at M3 |
| `data-on-edge="M1->M2"` | on the train `<g>` | Last `train_status` interpolated it onto this edge |
| `data-inferred="true"` | on an edge `<line>` | Edge was learned by discovery, not declared |

The simulator-ui side has `data-testid="sim-status"` on the status `dd`
(no semantic role available) and `data-testid="spawn-disabled-hint"`/
`spawn-error` on the inline hints. Everything else has a real role —
`getByRole('button', { name: /spawn train/i })` etc.

---

## Common journey scaffolds

### Spawn a train and watch it run

1. Sim-ui: click **Spawn train**. (No need to click Start or Resume —
   from idle, Spawn auto-starts and auto-resumes the sim.)
2. Visualiser: poll `[data-train-id="T1"]` to appear, then watch
   `data-on-edge` advance through the route's edges.

### Multi-train

The form's Train ID auto-increments after each spawn (T1 → T2 → T3),
so consecutive clicks on **Spawn train** give you distinct trains.
Clicking **Pause** between spawns adds the train without resuming the
sim — useful for staging.

### Swap layouts

1. Sim-ui: change the **Source** dropdown to a preset or to Custom JSON.
2. For Custom JSON: set the textarea value (use the native setter pattern
   if `fill` doesn't take), then click **Apply layout**.
3. Visualiser: the layout updates immediately — applying a layout
   republishes the retained state even when the sim hasn't been started.

If the layout JSON is referentially broken (edge points at an
undeclared marker), the form shows an inline error and does NOT
republish; the visualiser stays on the previous layout.

### Tear down cleanly

- **Stop button** in the sim-ui despawns the trains and tells the broker
  via `device_disconnected` events. The visualiser stops drawing them.
- **Closing the sim-ui tab** does the same thing via the `pagehide`
  handler in `useSimRunner`. Chromium dispatches `pagehide` synchronously
  during close, so the MQTT publish flushes before the WebSocket dies.

---

## What's NOT available in this setup

The standalone simulator-ui has its own in-browser scheduler. **There is
no `@trainframe/server` running** — that's the binary that exposes the
admin HTTP API on port 3000 for tag-assignment, route-reassignment, and
gate hold/release. Discovery-loop journeys that POST to `/api/tags` or
`/api/trains/<id>/route` need the server up; the dev-server-only setup
won't service them.

If you need the admin API for a journey:

```sh
pnpm --filter @trainframe/server build
node packages/server/dist/cli.js \
  --layout path/to/layout.json \
  --broker mqtt://localhost:1883 \
  --http-port 3000
```

This is also the path the ui-tests harness takes internally — see
`packages/ui-tests/src/test-harness.ts:startUiHarness`.

---

## After-action cleanup

- Stop the dev servers if you started them (`Ctrl-C` or `kill` the bash
  background jobs).
- If you stopped the user's broker to free port 9001 for an in-line
  ui-tests run, **restart it** (`podman start trainframe-broker`).
- Don't leave Chrome MCP processes alive across long pauses —
  `chrome-devtools-mcp` shares one profile and the singleton lock is a
  tax on the next session.

---

## Why this lives in the repo (not as a Claude skill)

Skills live in `~/.claude/skills/` and are global to the user.
Trainframe-specific knowledge — the data attributes the visualiser
exposes, the exact ports, the existence of `useSimRunner`'s pagehide
handler — belongs alongside the code so it stays accurate as the code
evolves. `CLAUDE.md` references this doc so future sessions reach for it.
