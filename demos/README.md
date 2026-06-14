# Demo videos

Rendered demo videos, committed here (outside the gitignored `packages/ui-tests/videos/`)
so they can be downloaded straight from the repo.

| Video | What it shows | Rendered by |
| --- | --- | --- |
| `trainframe-showcase.mp4` | A hi-res (1080p) reel of the best physics + device scenes — railyard CV-shunting, depot roundhouse (nested zones), 8-way turntable, dock-jib crate drop, lift bridge, momentum head-on, tractive load, derail. | `packages/ui-tests/scripts/showcase-video.mjs` |
| `trainframe-railyard-demo.mp4` | The multi-loop railyard demo on the **physics substrate** — five trains across two independent loops (each with its own station platforms), and the main loop's trains taking turns through the **CV railyard** (gantry crane on its truss working the wedge; correct shunting: real-rail coupling, no phantom flip, no floating rakes). Three different trains are serviced in turn. | `packages/ui-tests/scripts/showcase-video.mjs railyard-demo:165` (`?physics=railyard-demo`) |

To re-render, run the script against a running simulator-ui dev server (see each
script's header for the command + prerequisites).
