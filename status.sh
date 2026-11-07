#!/bin/bash
# status.sh — one-screen health report for the LAN party.
#
# Answers the questions you actually ask when something is wrong:
#   is the stack up? is the watchdog alive? which address do I share?
#   is the WebRTC signaling path working? did the server see anyone connect?
#
# Read-only: it never changes anything.
cd "$(dirname "$0")" || exit 1

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

echo ""
echo "  CS 1.6 LAN party — status"
echo "  ─────────────────────────"

# --- containers -------------------------------------------------------------
echo ""
echo "  Containers"
if ! command -v docker >/dev/null 2>&1; then
  bad "docker is not installed"
elif ! docker info >/dev/null 2>&1; then
  bad "Docker is not running (start Docker Desktop / the docker service)"
else
  for c in cs16-web cs16-proxy; do
    state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "missing")
    case "$state" in
      running) ok "$c: running" ;;
      missing) bad "$c: not created — run ./start.sh" ;;
      *)       bad "$c: $state — run ./start.sh" ;;
    esac
  done
fi

# --- HTTP + signaling -------------------------------------------------------
echo ""
echo "  Web endpoint"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:27016/healthz 2>/dev/null || true)
  if [ "$code" = "200" ]; then ok "proxy answers on 27016 (/healthz)"; else bad "no answer on :27016 (got '${code:-none}')"; fi

  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:27016/ 2>/dev/null || true)
  if [ "$code" = "200" ]; then ok "game page served"; else bad "game page returns '${code:-none}'"; fi

  # The WebRTC signaling socket must reach the game container, otherwise every
  # player ends up on the main menu. 101 = upgraded.
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        http://127.0.0.1:27016/websocket 2>/dev/null || true)
  if [ "$code" = "101" ]; then ok "signaling path /websocket upgrades (players can connect)"
  elif [ "$code" = "000" ] || [ -z "$code" ]; then bad "signaling path /websocket did not answer"
  else warn "signaling path /websocket returned '${code}' (expected 101)"; fi
else
  warn "curl not installed — skipping HTTP checks"
fi

# --- LAN address ------------------------------------------------------------
echo ""
echo "  Share this link"
if grep -qE '^[[:space:]]*IP:[[:space:]]*[0-9]' docker-compose.yml 2>/dev/null; then
  IP=$(awk -F': *' '/^[[:space:]]*IP:/{print $2; exit}' docker-compose.yml | tr -d ' ')
  info "http://$IP:27016"
  # Warn when the compose IP no longer matches this machine (WebRTC needs it).
  CUR=""
  command -v ip >/dev/null 2>&1 && CUR=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
  if [ -n "$CUR" ] && [ "$CUR" != "$IP" ]; then
    warn "this machine's IP looks like $CUR — re-run ./start.sh if the link stops working"
  fi
else
  bad "no IP: in docker-compose.yml — run ./start.sh"
fi

# --- watchdog ---------------------------------------------------------------
echo ""
echo "  Watchdog (auto-recovery)"
if [ -f .watchdog.pid ] && kill -0 "$(cat .watchdog.pid 2>/dev/null || echo 0)" 2>/dev/null; then
  ok "running (pid $(cat .watchdog.pid))"
else
  warn "not running — ./watchdog.sh starts it (./start.sh does this for you)"
fi
if [ -f watchdog.log ]; then
  info "last events:"
  tail -n 3 watchdog.log | sed 's/^/      /'
fi

# --- players ----------------------------------------------------------------
echo ""
echo "  Last players seen by the server"
if command -v docker >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Status}}' cs16-web 2>/dev/null)" != "" ]; then
  docker logs --tail 400 cs16-web 2>&1 \
    | grep -E '"(connected|entered the game|disconnected)"' \
    | tail -n 5 | sed 's/^/      /' || info "(no joins in the recent log)"
  if docker logs --tail 400 cs16-web 2>&1 | grep -q "server started"; then ok "dedicated server has started"; else warn "no 'server started' in the recent log"; fi
else
  info "(container not available)"
fi
echo ""
