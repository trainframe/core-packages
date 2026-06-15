# Demo videos

Rendered demo videos, committed here (outside the gitignored `packages/ui-tests/videos/`)
so they can be downloaded straight from the repo.

| Video | What it shows | Rendered by |
| --- | --- | --- |
| `trainframe-showcase.mp4` | A hi-res (1080p) reel of the best physics + device scenes — railyard CV-shunting, depot roundhouse (nested zones), 8-way turntable, dock-jib crate drop, lift bridge, momentum head-on, tractive load, derail. | `packages/ui-tests/scripts/showcase-video.mjs` |
| `trainframe-railyard-demo.mp4` | The branching railyard demo driven by the **real `@trainframe/server` scheduler** (not a bespoke controller). Three trains run a branching network — a main loop, a scenic spur branch (HILLSIDE / CENTRAL platforms), and an **in-line CV railyard** (gantry crane on its truss working the wedge) — taking turns through the yard zone, which gates admission so they queue. Routing, clearance, junction switching and yard occupancy are all the scheduler's; the physics world + its devices (`ScheduledTrainDevice` / `SwitchDevice` / `YardZoneDevice`) run in the browser over MQTT. Deadlock-free (gated by `branching-liveness.test.ts`). | `packages/ui-tests/scripts/branching-spectacle-video.mjs` (`?physics=branching`; needs the in-process harness it boots) |

To re-render, run the script against a running simulator-ui dev server (see each
script's header for the command + prerequisites).
