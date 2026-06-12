# Demo videos

Rendered demo videos, committed here (outside the gitignored `packages/ui-tests/videos/`)
so they can be downloaded straight from the repo.

| Video | What it shows | Rendered by |
| --- | --- | --- |
| `trainframe-showcase.mp4` | A hi-res (1080p) reel of the best physics + device scenes — railyard CV-shunting, depot roundhouse (nested zones), 8-way turntable, dock-jib crate drop, lift bridge, momentum head-on, tractive load, derail. | `packages/ui-tests/scripts/showcase-video.mjs` |
| `trainframe-spectacle.mp4` | The multi-train spectacle on the **physics substrate** — trains circulating an interesting turning/splitting track and calling at the **physics railyard** (correct shunting: real-rail coupling, no phantom flip, no floating rakes). | `packages/ui-tests/scripts/…` (`?physics=spectacle`) |

To re-render, run the script against a running simulator-ui dev server (see each
script's header for the command + prerequisites).
