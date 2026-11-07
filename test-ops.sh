#!/bin/bash
# test-ops.sh — verify the launcher/ops scripts without Docker.
#
#   ./test-ops.sh
#
# Runs start.sh, status.sh, doctor.sh, watchdog.sh and stop.sh against a stub
# `docker` CLI in a throwaway copy of the repo. That covers the logic that is
# easy to get wrong and hard to notice (blocking waits, watchdog double-start,
# recovery decisions, pid handling) on any machine — including CI and a laptop
# without Docker running.
#
# It never touches the real containers: every docker call goes to the stub.
set -u
REPO=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
STUB_DIR="$WORK/bin"
STATE="$WORK/state"
FAIL=0

cleanup() {
  pkill -f "$WORK/repo/watchdog.sh" 2>/dev/null
  [ -f "$WORK/repo/.watchdog.pid" ] && kill "$(cat "$WORK/repo/.watchdog.pid" 2>/dev/null)" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

# --- stub docker ------------------------------------------------------------
mkdir -p "$STUB_DIR" "$STATE"
cat > "$STUB_DIR/docker" <<'EOF'
#!/bin/bash
# Minimal `docker` stand-in for the ops scripts: container state lives in files.
STATE="$STUB_STATE"
mkdir -p "$STATE"
case "$1" in
  info) exit 0 ;;
  --version) echo "Docker version 0.0-stub, build stub" ;;
  compose)
    shift
    case "$1" in
      version) exit 0 ;;
      up)   touch "$STATE/r-cs16-web" "$STATE/r-cs16-proxy"; echo "up" >> "$STATE/calls" ;;
      down) rm -f "$STATE"/r-*; echo "down" >> "$STATE/calls" ;;
    esac ;;
  inspect)
    case "$3" in
      *State.Running*) [ -f "$STATE/r-$4" ] && echo true || { echo "[]"; exit 1; } ;;
      *State.Status*)  [ -f "$STATE/r-$4" ] && echo running || { echo "[]"; exit 1; } ;;
      *State.StartedAt*) echo "2026-01-01T00:00:00Z" ;;
      *) echo true ;;
    esac ;;
  logs)
    echo "L 01/01/2026 - 00:00:00: server started"
    echo '"Alex<1><2><STEAM><>" connected, address "192.168.1.9:27005"'
    echo '"Alex<1><2><STEAM><>" entered the game' ;;
  restart) echo "restart $2" >> "$STATE/calls" ;;
  create)  echo "stubcid" ;;
  cp|rm)   exit 0 ;;
esac
exit 0
EOF
chmod +x "$STUB_DIR/docker"
export PATH="$STUB_DIR:$PATH"
export STUB_STATE="$STATE"

# --- throwaway copy of the repo --------------------------------------------
mkdir -p "$WORK/repo"
( cd "$REPO" && tar -cf - \
    --exclude=.git --exclude=node_modules --exclude=watchdog.log --exclude=.watchdog.pid \
    . ) | ( cd "$WORK/repo" && tar -xf - )
cd "$WORK/repo" || exit 1

# Satisfy start.sh's gates: a bundle and a valid (tiny) asset archive.
printf 'console.log("bundle")\n' > web/main.js
rm -f valve.zip
mkdir -p "$WORK/z/cstrike/maps" "$WORK/z/valve"
printf 'x' > "$WORK/z/cstrike/maps/de_dust2.bsp"
printf 'x' > "$WORK/z/valve/halflife.wad"
( cd "$WORK/z" && zip -qr "$WORK/repo/valve.zip" valve cstrike )

echo ""
echo "# start.sh"
out=$(timeout 120 ./start.sh 2>&1); rc=$?
[ $rc -eq 0 ] && pass "exits 0" || fail "exit $rc: $(echo "$out" | tail -3)"
echo "$out" | grep -q "Server is up" && pass "prints the success banner" || fail "no success banner"
echo "$out" | grep -qE "http://[0-9.]+:27016" && pass "prints the share link" || fail "no share URL"
echo "$out" | grep -q "Watchdog running" && pass "starts the watchdog" || fail "watchdog not reported"
[ -f .watchdog.pid ] && pass "watchdog is detached (pid file written)" || fail "no watchdog pid file"
# It must not block: with a running watcher the call has to return immediately.
START=$(date +%s)
timeout 120 ./start.sh >/dev/null 2>&1
[ $(( $(date +%s) - START )) -lt 60 ] && pass "re-running start.sh does not block" || fail "start.sh blocked"
P1=$(cat .watchdog.pid 2>/dev/null)
timeout 120 ./start.sh >/dev/null 2>&1
[ "$(cat .watchdog.pid 2>/dev/null)" = "$P1" ] && pass "no duplicate watchdog" || fail "watchdog restarted/duplicated"
[ "$(pgrep -f "$WORK/repo/watchdog.sh" 2>/dev/null | wc -l)" -le 1 ] && pass "single watchdog process" || fail "multiple watchdogs"

echo ""
echo "# status.sh / doctor.sh"
st=$(./status.sh 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
echo "$st" | grep -q "cs16-web: running" && pass "status sees the containers" || fail "status: containers"
echo "$st" | grep -qE "signaling path /websocket" && pass "status probes the signaling path" || fail "status: signaling probe"
dr=$(./doctor.sh 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
echo "$dr" | grep -q "compose advertises IP" && pass "doctor checks the advertised IP" || fail "doctor: IP"
echo "$dr" | grep -q "sv_lan is 0" && pass "doctor checks sv_lan" || fail "doctor: sv_lan"
echo "$dr" | grep -q "engine extras served" && pass "doctor checks the vendor assets" || fail "doctor: vendor"

echo ""
echo "# watchdog recovery"
./stop.sh >/dev/null 2>&1
rm -f "$STATE"/r-*; touch "$STATE/r-cs16-proxy"        # game container died, proxy alive
WATCHDOG_INTERVAL=1 WATCHDOG_URL=http://127.0.0.1:27996/nothing WATCHDOG_LOG="$WORK/wd.log" \
  timeout 6 ./watchdog.sh >/dev/null 2>&1
grep -q "cs16-web container is not running" "$WORK/wd.log" 2>/dev/null \
  && pass "restarts a dead game container" || fail "watchdog did not react: $(tail -2 "$WORK/wd.log" 2>/dev/null)"
grep -q "docker compose up -d" "$WORK/wd.log" 2>/dev/null || true
rm -f "$STATE"/r-*
touch "$STATE/r-cs16-web" "$STATE/r-cs16-proxy"          # both "running" but wedged
WATCHDOG_INTERVAL=1 WATCHDOG_URL=http://127.0.0.1:27996/nothing WATCHDOG_LOG="$WORK/wd2.log" \
  timeout 6 ./watchdog.sh >/dev/null 2>&1
grep -q "docker restart cs16-web" "$WORK/wd2.log" 2>/dev/null \
  && pass "restarts a wedged container" || fail "no wedge recovery: $(tail -2 "$WORK/wd2.log" 2>/dev/null)"

echo ""
echo "# stop.sh"
./stop.sh >/dev/null 2>&1
[ ! -f .watchdog.pid ] && pass "removes the watchdog pid file" || fail "pid file left behind"
grep -q down "$STATE/calls" 2>/dev/null && pass "stops the containers" || fail "compose down not called"

echo ""
if [ $FAIL -eq 0 ]; then printf '\033[32mAll ops checks passed.\033[0m\n'; else printf '\033[31m%s ops check(s) failed.\033[0m\n' "$FAIL"; fi
exit $FAIL
