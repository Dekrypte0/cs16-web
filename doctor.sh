#!/bin/bash
# doctor.sh — "why can't I join?" in one command.
#
#   ./doctor.sh
#
# Checks every link in the chain, in the order it can break, and prints exactly
# what to do about the first thing that is wrong. Read-only (except that it
# pulls the image layer list, which is local).
cd "$(dirname "$0")" || exit 1

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FIXES+=("$*"); }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
hint() { printf '      \033[90m→ %s\033[0m\n' "$*"; }
FIXES=()

echo ""
echo "  CS 1.6 LAN party — doctor"
echo "  ────────────────────────"

# 1 ─ host tooling -----------------------------------------------------------
echo ""
echo " 1. Host tooling"
command -v docker >/dev/null 2>&1 && ok "docker found ($(docker --version 2>/dev/null | cut -d, -f1))" \
  || bad "docker is not installed"
if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 && ok "Docker daemon is running" \
    || bad "Docker is installed but not running (start Docker Desktop / the docker service)"
  docker compose version >/dev/null 2>&1 && ok "docker compose is available" \
    || bad "docker compose v2 is missing (update Docker Desktop)"
fi
command -v curl >/dev/null 2>&1 && ok "curl found" || warn "curl missing — health checks are weaker"

# 2 ─ project files ----------------------------------------------------------
echo ""
echo " 2. Project files"
for f in docker-compose.yml proxy/nginx.conf web/index.html web/join.js cstrike/server.cfg; do
  [ -s "$f" ] && ok "$f" || bad "$f is missing or empty"
done
if [ -s web/main.js ]; then ok "web/main.js (patched client bundle)"; else bad "web/main.js is missing — run ./prepare-client.sh (needs Docker)"; fi

if [ -f valve.zip ]; then
  if unzip -l valve.zip >/dev/null 2>&1; then
    SIZE=$(du -m valve.zip 2>/dev/null | cut -f1)
    ok "valve.zip is a valid archive (${SIZE} MB)"
    unzip -l valve.zip "cstrike/maps/de_dust2.bsp" >/dev/null 2>&1 \
      && ok "stock maps present (de_dust2)" \
      || bad "valve.zip has no cstrike/maps/de_dust2.bsp — it is not a CS 1.6 asset pack"
  else
    bad "valve.zip exists but is not a valid zip — delete it and re-run ./start.sh"
  fi
else
  bad "valve.zip is missing — run ./start.sh once to build it"
fi

# 3 ─ configuration ----------------------------------------------------------
echo ""
echo " 3. Configuration"
CFG_IP=$(awk -F': *' '/^[[:space:]]*IP:/{print $2; exit}' docker-compose.yml 2>/dev/null | tr -d ' ')
if [ -n "$CFG_IP" ]; then ok "compose advertises IP $CFG_IP"; else bad "no IP: in docker-compose.yml — run ./start.sh"; fi
CUR_IP=""
command -v ip >/dev/null 2>&1 && CUR_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
if [ -n "$CUR_IP" ] && [ -n "$CFG_IP" ]; then
  if [ "$CUR_IP" = "$CFG_IP" ]; then ok "it matches this machine's address ($CUR_IP)"
  else bad "this machine is $CUR_IP but the container advertises $CFG_IP (players will not connect)"; hint "re-run ./start.sh"; fi
fi
if grep -qE '^[[:space:]]*sv_lan[[:space:]]+1' cstrike/server.cfg 2>/dev/null; then
  bad "sv_lan is 1 in cstrike/server.cfg (breaks the map picker)"
else ok "sv_lan is 0"; fi
if grep -q 'rcon_password' cstrike/server.cfg 2>/dev/null; then ok "rcon password set (map picker works)"; else warn "no rcon_password"; fi

# 4 ─ containers -------------------------------------------------------------
echo ""
echo " 4. Containers"
for c in cs16-web cs16-proxy; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  if [ "$st" = "running" ]; then ok "$c running"; else bad "$c: $st"; hint "run ./start.sh"; fi
done

# 5 ─ the actual endpoints ---------------------------------------------------
echo ""
echo " 5. Endpoints (as a player sees them)"
if command -v curl >/dev/null 2>&1; then
  c=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:27016/healthz 2>/dev/null || true)
  [ "$c" = "200" ] && ok "proxy http://127.0.0.1:27016/healthz" || bad "proxy on :27016 not answering (${c:-none})"

  c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:27016/join.js 2>/dev/null || true)
  [ "$c" = "200" ] && ok "join layer served (/join.js)" || bad "join layer not served (${c:-none}) — is web/join.js mounted?"

  c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:27016/vendor/extras-fc0acba1.pk3 2>/dev/null || true)
  [ "$c" = "200" ] && ok "engine extras served (/vendor)" || warn "engine extras not served (${c:-none})"

  # /websocket must upgrade (101) or nobody can connect
  c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      http://127.0.0.1:27016/websocket 2>/dev/null || true)
  if [ "$c" = "101" ]; then ok "/websocket upgrades — signaling works"
  else bad "/websocket did not upgrade (${c:-none}) — players would land on the CS main menu"; hint "check: docker logs cs16-web | tail -30"; fi
fi

# 6 ─ the game server itself -------------------------------------------------
echo ""
echo " 6. Game server log"
if [ "$(docker inspect -f '{{.State.Status}}' cs16-web 2>/dev/null)" != "" ]; then
  if docker logs --tail 300 cs16-web 2>&1 | grep -q "server started"; then
    ok "dedicated server started"
  else
    bad "no 'server started' in the log"; hint "docker logs --tail 40 cs16-web"
  fi
  LAST=$(docker logs --tail 600 cs16-web 2>&1 | grep -E '"connected"|entered the game' | tail -1)
  if [ -n "$LAST" ]; then ok "last player activity: $LAST"; else warn "no players connected yet"; fi
  for e in "delta.lst not found" "couldn't open" "FATAL" "Host_Error"; do
    if docker logs --tail 300 cs16-web 2>&1 | grep -q "$e"; then
      bad "log contains '$e'"; hint "docker logs --tail 60 cs16-web"
    fi
  done
else
  warn "cs16-web container not available"
fi

# 7 ─ extras -----------------------------------------------------------------
echo ""
echo " 7. Convenience"
if [ -f .watchdog.pid ] && kill -0 "$(cat .watchdog.pid 2>/dev/null || echo 0)" 2>/dev/null; then
  ok "watchdog running (auto-recovers a wedged server)"
else
  warn "watchdog not running — ./watchdog.sh (./start.sh starts it)"
fi

# summary --------------------------------------------------------------------
echo ""
if [ ${#FIXES[@]} -eq 0 ]; then
  echo "  ✅ No problems found. Share: http://${CFG_IP:-<host-ip>}:27016"
  echo "     If a player still cannot join, open that link with ?debug=1 for their log."
else
  echo "  ✗ ${#FIXES[@]} problem(s) found; fix the first one above and re-run ./doctor.sh"
fi
echo ""
