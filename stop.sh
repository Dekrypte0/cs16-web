#!/bin/bash
# stop.sh — stop the LAN party (containers + background watchdog).
cd "$(dirname "$0")" || exit 1

if [ -f .watchdog.pid ]; then
  PID=$(cat .watchdog.pid 2>/dev/null || true)
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    # Give it a chance to exit cleanly (it removes its own pid file).
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
    echo "Watchdog stopped."
  fi
  rm -f .watchdog.pid
fi

docker compose down
echo "Server stopped."
