#!/bin/bash
# Regenerate the patched in-browser client bundle (web/main.js) from the pinned
# Docker image.
#
# The upstream client is shipped inside the Docker image under a content-hashed
# filename (e.g. main-Sj92UznW.js). We serve a patched copy so the map picker and
# web/join.js can drive the engine (window.__xash). This script re-extracts the
# bundle, re-applies the patch, and keeps the hashed filename in sync across
# web/index.html and docker-compose.yml.
#
# Run it after cloning, and again whenever you bump the image digest. Safe to
# re-run at any time: it prints the patch report and fails loudly if the
# upstream code shape changed.
set -e
cd "$(dirname "$0")"

# Read the game image from the cs16-web service specifically (the proxy service
# also has an image: line, so a blanket grep would grab both).
IMG=$(awk '/^  cs16-web:/{f=1} f && /^    image:/{print $2; exit}' docker-compose.yml)
[ -n "$IMG" ] || { echo "Could not read the cs16-web image from docker-compose.yml."; exit 1; }

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running — it is needed to extract the upstream client bundle."
  echo "Start Docker (or Docker Desktop) and re-run ./prepare-client.sh"
  exit 1
fi

echo "Extracting web client from $IMG ..."
CID=$(docker create "$IMG") || { echo "Could not access $IMG — check your connection."; exit 1; }
trap 'docker rm -f "$CID" >/dev/null 2>&1' EXIT
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; docker rm -f "$CID" >/dev/null 2>&1' EXIT

if ! docker cp "$CID:/xashds/public/assets" "$TMP/assets" >/dev/null 2>&1; then
  echo "Could not copy /xashds/public/assets out of the image."
  echo "If you bumped the image, check that the path still exists:"
  echo "  docker run --rm $IMG ls /xashds/public/assets"
  exit 1
fi

MAINJS=$(cd "$TMP/assets" && ls main-*.js 2>/dev/null | head -1)
if [ -z "$MAINJS" ]; then echo "Could not find main-*.js in the image."; exit 1; fi
echo "Bundle: $MAINJS"

mkdir -p web
# The patch itself lives in patch-main.pl (perl, no extra deps — see its
# header). It exposes the engine as window.__xash for the map picker and
# web/join.js, and fails loudly if the upstream bundle changed shape.
perl ./patch-main.pl "$TMP/assets/$MAINJS" web/main.js

if ! grep -q "window.__xash=new Xash3DWebRTC(" web/main.js; then
  echo "Patch did not apply — upstream bundle changed; inspect manually."
  exit 1
fi

# Keep the hashed filename consistent in the page and the compose mount.
# perl -i (not `sed -i`) so the in-place edit works the same on macOS and Linux.
perl -i -pe "s#/assets/main-[A-Za-z0-9_-]+\.js#/assets/$MAINJS#g" web/index.html
perl -i -pe "s#/xashds/public/assets/main-[A-Za-z0-9_-]+\.js#/xashds/public/assets/$MAINJS#g" docker-compose.yml

echo "Done. web/main.js regenerated and references updated to $MAINJS"
