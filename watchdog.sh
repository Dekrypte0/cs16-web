#!/bin/bash
# watchdog.sh — keep the LAN party alive while nobody is watching.
#
# Started automatically by ./start.sh (and stopped by ./stop.sh). It probes the
# public port every few seconds and, if the stack has been unreachable for a
# while, brings it back:
#
#   * proxy answering + game container running  -> nothing to do (the normal case)
#   * proxy/reporting port unreachable          -> `docker compose up -d`
#   * proxy up but game container not running   -> recreate just that container
#   * both running but the page is dead         -> `docker restart cs16-web`
#
# Only 3 consecutive failures (~1 minute) trigger an action, so a slow restart
# or a momentary hiccup never kicks players out. Everything is appended to
# watchdog.log so you can see after the fact what happened.
#
# Environment:
#   WATCHDOG_INTERVAL   seconds between probes      (default 20)
#   WATCHDOG_LOG        log file                    (default ./watchdog.log)
#   WATCHDOG_URL        probe URL                   (default http://127.0.0.1:27016/healthz)
#
# Run it in the foreground for debugging:  WATCHDOG_INTERVAL=5 ./watchdog.sh --verbose
set -u
cd "$(dirname "$0")" || exit 1

INTERVAL=${WATCHDOG_INTERVAL:-20}
LOG=${WATCHDOG_LOG:-watchdog.log}
PROBE_URL=${WATCHDOG_URL:-http://127.0.0.1:27016/healthz}
PIDFILE=.watchdog.pid
STRIKES=0
MAX_STRIKES=3
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  printf '%s\n' "$line" >> "$LOG"
  [ "$VERBOSE" = "1" ] && printf '%s\n' "$line"
}

# --- single instance --------------------------------------------------------
if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "${OLD:-}" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "watchdog already running (pid $OLD) — nothing to do."
    exit 0
  fi
  rm -f "$PIDFILE"
fi
printf '%s\n' "$$" > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
trap 'log "watchdog stopping"; exit 0' INT TERM

# --- probes -----------------------------------------------------------------
# Prefer curl; fall back to a plain TCP connect via bash so the watchdog works
# on a minimal Linux/WSL host without curl installed.
probe_http() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 6 -o /dev/null "$PROBE_URL" 2>/dev/null
    return $?
  fi
  probe_tcp
}

probe_tcp() {
  local host port
  host=${PROBE_URL#*://}
  host=${host%%/*}
  port=${host##*:}
  [ "$port" = "$host" ] && port=80
  host=${host%%:*}
  ( exec 3<>"/dev/tcp/$host/$port" ) >/dev/null 2>&1
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

recover() {
  local why="$1"
  log "recovering ($why)"
  if ! container_running cs16-web; then
    log "cs16-web container is not running -> docker compose up -d"
    docker compose up -d >>"$LOG" 2>&1 || log "docker compose up failed"
  elif ! container_running cs16-proxy; then
    log "cs16-proxy container is not running -> docker compose up -d"
    docker compose up -d >>"$LOG" 2>&1 || log "docker compose up failed"
  else
    # Both containers claim to be running but the page does not answer: the
    # game process is wedged (this is the failure that otherwise leaves players
    # stuck on a broken black page until someone notices).
    log "containers running but ${PROBE_URL} is dead -> docker restart cs16-web"
    docker restart cs16-web >>"$LOG" 2>&1 || log "docker restart failed"
    sleep 8
  fi
  # Give it a moment, then report whether it came back.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if probe_http; then log "recovered"; return 0; fi
    sleep 2
  done
  log "still down after recovery attempt — will keep trying"
  return 1
}

# --- main loop --------------------------------------------------------------
log "watchdog started (interval ${INTERVAL}s, probe $PROBE_URL, pid $$)"
# Keep the log from growing forever during a long session.
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$LOG" "$LOG.1"
  log "log rotated"
fi

while :; do
  if probe_http; then
    if [ "$STRIKES" -gt 0 ]; then log "back up after $STRIKES failed probe(s)"; fi
    STRIKES=0
  else
    STRIKES=$((STRIKES + 1))
    log "probe failed ($STRIKES/$MAX_STRIKES)"
    if [ "$STRIKES" -ge "$MAX_STRIKES" ]; then
      recover "unreachable for $((STRIKES * INTERVAL))s"
      STRIKES=0
    fi
  fi
  sleep "$INTERVAL"
done
