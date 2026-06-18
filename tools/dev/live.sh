#!/usr/bin/env bash
#
# One-shot live dev stack for hand-driving the toy table + visualiser.
#
# Brings up, in order: the MQTT broker (mosquitto, via podman compose), the real
# @trainframe/server (discovery mode, HTTP admin on :3000), the simulator-ui dev
# server (:5174 — the toy table) and the visualiser dev server (:5173). Ctrl-C
# (or any exit) tears the whole lot down: server + both Vite servers killed, the
# ports freed, and the broker container stopped.
#
# Usage:
#   tools/dev/live.sh            # start everything (builds the server if needed)
#   tools/dev/live.sh --build    # force a fresh server build first
#
# Open http://localhost:5174 (toy table) and http://localhost:5173 (visualiser).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE="tools/broker/docker-compose.yml"
BROKER_PORT=1883
SERVER_HTTP_PORT=3000
SIM_UI_PORT=5174
VIS_PORT=5173

FORCE_BUILD=0
[[ "${1:-}" == "--build" ]] && FORCE_BUILD=1

# --- pretty logging ---------------------------------------------------------
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }

# Assign the first free port at or above `preferred` to the named variable,
# skipping ports already in use AND ones we've reserved this run (so the three
# servers never collide before any has started listening).
RESERVED=()
pick_port() { # usage: pick_port VARNAME preferred
  local __var="$1" p="$2"
  while lsof -ti "tcp:${p}" >/dev/null 2>&1 || [[ " ${RESERVED[*]:-} " == *" ${p} "* ]]; do
    p=$((p + 1))
  done
  RESERVED+=("$p")
  printf -v "$__var" '%s' "$p"
}

PIDS=()
STARTED_BROKER=0

cleanup() {
  echo
  bold "Tearing down the live stack…"
  # Kill the node/vite processes we launched, plus any children they spawned.
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
  # Belt-and-braces: free the dev ports in case a child outlived its parent.
  # Safe to do unconditionally — the preflight guaranteed these ports were ours.
  for port in "$SERVER_HTTP_PORT" "$SIM_UI_PORT" "$VIS_PORT"; do
    lsof -ti "tcp:${port}" 2>/dev/null | xargs -r kill 2>/dev/null || true
  done
  # Only stop the broker if WE started it — leave a pre-existing one alone.
  if [[ "$STARTED_BROKER" == "1" ]]; then
    info "Stopping the broker…"
    podman compose -f "$COMPOSE" down >/dev/null 2>&1 || true
  fi
  bold "Done."
}

# --- preflight (BEFORE the trap, so a refusal never tears anything down) -----
command -v podman >/dev/null || { warn "podman not found on PATH"; exit 1; }
command -v pnpm >/dev/null || { warn "pnpm not found on PATH"; exit 1; }

# Pick free ports (preferred ones if available, otherwise the next free port up),
# so this can run alongside another stack without fighting over ports. We launch
# the server + both Vite servers on exactly these, so teardown only ever kills
# what we started.
pick_port SERVER_HTTP_PORT "$SERVER_HTTP_PORT"
pick_port SIM_UI_PORT "$SIM_UI_PORT"
pick_port VIS_PORT "$VIS_PORT"

trap cleanup EXIT INT TERM

# --- 1. server build (deps resolve to built dist) ---------------------------
if [[ "$FORCE_BUILD" == "1" || ! -f packages/server/dist/cli.js ]]; then
  info "Building the server (and its workspace deps)…"
  pnpm --filter "@trainframe/server..." build
else
  info "Server build present — skipping (pass --build to force a rebuild)."
fi

# --- 2. broker --------------------------------------------------------------
if nc -z localhost "$BROKER_PORT" 2>/dev/null; then
  info "Broker already up on :$BROKER_PORT — reusing it (won't stop it on exit)."
else
  info "Starting the MQTT broker (mosquitto)…"
  podman compose -f "$COMPOSE" up -d mosquitto
  STARTED_BROKER=1
fi
# Wait for the broker to accept connections.
for _ in $(seq 1 30); do
  if nc -z localhost "$BROKER_PORT" 2>/dev/null; then break; fi
  sleep 0.3
done
nc -z localhost "$BROKER_PORT" 2>/dev/null || { warn "broker did not come up on :$BROKER_PORT"; exit 1; }

# --- 3. server --------------------------------------------------------------
info "Starting @trainframe/server (discovery, http :$SERVER_HTTP_PORT)…"
node packages/server/dist/cli.js \
  --discovery \
  --broker "mqtt://localhost:${BROKER_PORT}" \
  --http-port "$SERVER_HTTP_PORT" &
PIDS+=("$!")

# --- 4. front-ends (Vite dev, HMR) ------------------------------------------
info "Starting the toy table (simulator-ui, :$SIM_UI_PORT)…"
pnpm --filter @trainframe/simulator-ui exec vite --port "$SIM_UI_PORT" --strictPort &
PIDS+=("$!")

info "Starting the visualiser (:$VIS_PORT)…"
pnpm --filter @trainframe/visualiser exec vite --port "$VIS_PORT" --strictPort &
PIDS+=("$!")

echo
bold "Live stack up — drive it by hand:"
echo "    Toy table   →  http://localhost:${SIM_UI_PORT}"
echo "    Visualiser  →  http://localhost:${VIS_PORT}"
echo "    Server HTTP →  http://localhost:${SERVER_HTTP_PORT}"
echo "    Broker      →  mqtt://localhost:${BROKER_PORT}  (ws :9001)"
echo
warn "Use localhost (not 127.0.0.1). Press Ctrl-C to stop everything."

# Park until interrupted; if any child dies, fall through to cleanup.
wait
