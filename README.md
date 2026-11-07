# CS 1.6 in the Browser — LAN Party Server

Counter-Strike 1.6, playable **right in the browser** over your local network — no
installs, no Steam, no downloads for players. The host runs one Docker container;
everyone else just opens a link, types a nickname, and plays.

Built on [Xash3D FWGS (WebAssembly)](https://github.com/yohimik/webxash3d-fwgs) with
browser↔server networking over WebRTC. Everything runs on the host machine — no
internet required once the assets are cached.

![Gameplay on de_dust2](docs/img/gameplay-de_dust2.png)

### Highlights

| | |
|---|---|
| 🗺 **In-browser map picker** | Switch the map for everyone, mid-game, no console. |
| 💰 **Full arsenal** | Everyone spawns with max money every round. |
| 🏠 **Custom maps** | e.g. `cs_mansion`, fetched and wired in automatically. |
| ⎋ **Polished UX** | `Esc` opens the map picker instead of a broken engine menu. |

<table>
  <tr>
    <td><img src="docs/img/map-picker.png" alt="In-browser map picker"></td>
    <td><img src="docs/img/gameplay-cs_mansion.png" alt="cs_mansion"></td>
  </tr>
  <tr>
    <td align="center"><em>The in-browser map picker</em></td>
    <td align="center"><em>Custom map: cs_mansion</em></td>
  </tr>
</table>

---

## How to play

**Prerequisites:** just [Docker Desktop](https://www.docker.com/products/docker-desktop/).
The game assets (`valve.zip`, ~210 MB — trimmed of Half-Life content CS 1.6 never loads) are
**not** shipped in this repo (Valve copyright + size); on the host's first run `start.sh` builds
them automatically from the pinned server image — no SteamCMD or manual download needed.

**Host OS:** `start.sh` runs on **macOS and Linux** natively, and on **Windows via WSL2**
(or Git Bash) — it's a bash script and won't run in native cmd/PowerShell. **Players** join
from any OS in any modern browser; only the host runs the script.

```bash
cd cs16-web
./start.sh
```

`start.sh` starts Docker if needed, builds the patched web client, builds the game
assets (`valve.zip`) from the pinned server image if they're missing, pulls custom maps
on first run, detects the host's LAN IP, writes it into the config, and copies a
ready-to-share link to the clipboard — just paste it into your team chat.

Everyone on the same Wi-Fi/LAN opens the link in Chrome / Edge / Firefox, enters a
nickname, waits for the assets to load (~210 MB on first visit, then cached), picks a
team — and plays. Everyone spawns with **$16000**, so walk into spawn and buy anything.

Stop the server: `./stop.sh`. Live logs: `docker logs -f cs16-web`.

## Running a LAN party in the office

1. **Host machine** — any Mac/PC with [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   installed, on the office Wi-Fi/LAN. This is the only machine that needs setup.
2. **First-time build** of the game content (`valve.zip`) happens automatically on the
   first `./start.sh` — it's extracted from the pinned server image and reused forever
   (no SteamCMD needed). To rebuild it manually, see [Rebuilding `valve.zip`](#rebuilding-valvezip).
3. **Launch:** `./start.sh`. It prints and copies a link like `http://192.168.1.201:27016`.
4. **Share the link** in the team chat. Players just open it — nothing to install.
5. **Firewall:** allow inbound TCP `27016` and TCP/UDP `27018` on the host (macOS will
   prompt once; on Windows allow Docker through the firewall). Everyone must be on the
   **same network** (WebRTC needs direct UDP — guest/AP-isolated Wi-Fi won't work).
6. **Switched networks?** Re-run `./start.sh` — it rewrites the host IP and reshares the link.

Recommended: 16-player default; pick the map from the in-browser picker once people join.

## "It loads, then drops me in the CS main menu"

That is the classic symptom of a browser that booted the engine fine but could
**not reach the dedicated server**: the engine falls back to its own
Counter-Strike main menu and says nothing. Since v1.1 the page ships a **join
layer** (`web/join.js`) that removes the guesswork:

- it issues `connect <host:27018>` for you once the engine is up, and **retries**
  (3 attempts, 20 s each),
- it **classifies the engine log**, so a dead connection produces a readable card
  ("Could not join the game server", the address it tried, what to check) instead
  of a silent menu,
- it can start an **offline game with bots** so you can still play while you fix
  the network,
- it keeps a **connection log**: open `http://<host>:27016/?debug=1`, or press
  **F8** at any time, and use *Copy log* when asking for help.

Quick checklist for a join that keeps failing:

1. Host is running `./start.sh` (both containers: `cs16-web` and `cs16-proxy`).
2. Players are on the **same LAN** — guest/AP-isolated Wi-Fi blocks WebRTC.
3. Host firewall allows TCP `27016` and TCP/UDP `27018`.
4. The `IP:` in `docker-compose.yml` is the host's **current** LAN IP (re-run
   `./start.sh` after a network change — it rewrites it).
5. Try `http://<host>:27016/?connect=<host-ip>:27018` to point a client at a
   specific address (handy when the page is reached via a different hostname,
   e.g. a reverse proxy or a VPN IP).

Useful URL options (all optional):

| Option | Effect |
|---|---|
| `?connect=<ip[:port]>` | server to join (default: page host, port 27018) |
| `?connect=0` | do not auto-join; stay on the menu |
| `?name=<nick>` | prefill the player name |
| `?bots=1&map=de_dust2&difficulty=2&quota=9` | start an offline bot game |
| `?debug=1` | open the connection log immediately |
| `?joinTimeout=<ms>&joinAttempts=<n>` | tune the retry behaviour on a slow LAN |
| `?joinDrop=<n>&joinIdle=<ms>` | quiet reconnects after a dropped connection, then background retries |
| `?joinProbe=<ms>&joinStall=<ms>` | engine watchdog sensitivity |

Both test suites run with one command:

```bash
npm test          # = node test-join.js && ./test-ops.sh
```

- `test-join.js` — 62 assertions against the real `web/join.js` in jsdom, with a
  simulated engine: address normalisation, connect/retry/exhaustion, drops and
  recovery, the engine watchdog, bot mode, persistence, and "no engine at all".
  jsdom is a dev dependency only.
- `test-ops.sh` — runs `start.sh`, `status.sh`, `doctor.sh`, `watchdog.sh` and
  `stop.sh` against a **stub `docker`**, so it verifies the launcher logic
  (detached watchdog, no double-start, recovery decisions, pid handling) on a
  machine without Docker.

## Leaving it running unattended

The stack is built to survive a long session with nobody at the keyboard:

| Piece | What it does |
|---|---|
| `./watchdog.sh` (started by `./start.sh`) | Probes `:27016` every 20 s. Three failures in a row (~1 min) and it recovers by itself: dead container → `docker compose up -d`, wedged container → `docker restart cs16-web`. Log: `watchdog.log`. |
| Browser join layer | Re-joins on its own: if the connection drops mid-game it retries quietly (3×), then keeps retrying every 12 s in the background — so a host who restarts the server still gets everyone back in. |
| Engine watchdog | If the engine stops answering for 45 s while "connected", the player is quietly re-joined instead of sitting on a dead server. |
| nginx offline page | While the game container restarts, players get a friendly "starting…" page that reloads itself every 5 s instead of a bare 502. |

Useful commands after an hour away:

```bash
./status.sh     # one screen: containers, endpoints, share link, watchdog, last joins
./doctor.sh     # "why can't I join?" — checks every link and prints the fix
tail -f watchdog.log
```

Stop everything (including the watchdog): `./stop.sh`.

### Playing alone (no Wi-Fi at all)

Open the link and click **▶ Start a local game (no network needed)** — bots on
`de_dust2`, no WebRTC involved. Great for checking that your client and assets
are healthy before blaming the network.

## Changing the map

**From the browser (recommended).** While playing, press **Esc** to free the mouse,
then click the **🗺 Maps** button at the top and choose a map. It switches the map for
**everyone** within a few seconds — then click back into the game to keep playing.
(Internally it sends `rcon changelevel` over the existing connection; the RCON password
lives in `cstrike/server.cfg` and is intentionally public on a LAN.)

**Default map at boot.** Edit `command:` in `docker-compose.yml`
(`["+map", "de_dust2", "+maxplayers", "16"]`) and run `./start.sh`.

## Custom maps (e.g. cs_mansion)

Stock CS 1.6 maps ship inside `valve.zip`. Custom (non-stock) maps are **bundled in the
repo** under `custom-maps/` and mounted into the dedicated server. Because `valve.zip` is
rebuilt locally (not committed), `./add-maps.sh` injects the bundled `.bsp` files into it
so browsers can load them too — `./start.sh` runs this automatically on first launch.

`cs_mansion` is included by default. To add another custom map:

1. drop `<map>.bsp` into `custom-maps/` (or add an `add_map <name> <zip-url>` line to
   `add-maps.sh` to fetch it), mount it in `docker-compose.yml`, and run `./add-maps.sh`,
2. add the map name to the `CUSTOM` array in `web/index.html` so it shows in the picker.

> Custom maps must use stock textures, or bundle their own WAD/textures into `valve.zip`.
> `cs_mansion` uses only stock WADs, so the `.bsp` alone is enough.

## Full arsenal for everyone

`cstrike/server.cfg` sets `mp_startmoney 16000` and a long `mp_buytime`, so every player
can buy the entire arsenal from spawn each round. Tweak those values to taste.

## How it works — the patched web client

The browser client is patched purely through Docker volume mounts; the upstream image is
never modified:

- **`web/index.html`** — adds the map-picker overlay and swallows the **Esc** key before
  it reaches the engine. The engine's own in-game menu renders as a black screen in this
  build (its TTF fonts are missing), so we suppress it; the browser still releases the
  mouse, which reveals the map picker instead. The picker lives in `<head>` and
  self-heals, because the engine rebuilds `<body>` on load.
- **`web/main.js`** — **generated** by `./prepare-client.sh` (patches applied by
  `patch-main.pl`); it exposes the engine instance on `window.__xash` so the map
  picker and the join layer can run engine commands.
- **`web/join.js`** — the join layer. Loaded *before* the engine bundle; joins the
  server, retries, explains failures, offers offline bots and keeps the F8 log.
  Everything it does is feature-detected, so if it cannot talk to the engine the
  page behaves exactly as before.
- **`web/vendor/`** — the engine's `extras.pk3` (fonts, menu/touch assets; the
  pinned image does not ship it) and JSZip, both content-addressed/versioned and
  served `immutable` by the proxy so they cost nothing after the first visit.
- **`proxy/nginx.conf`** — a small nginx reverse-proxy sidecar (added in `docker-compose.yml`)
  that owns the public port `27016` and forwards to the game container internally. It injects
  the HTTP caching headers the in-image server can't — `immutable` for the content-hashed
  bundle/WASM, `no-cache` (store + revalidate) for `valve.zip` so a rebuild is picked up at
  once — so repeat visits don't re-download the payload. It passes the same-origin
  `/websocket` signaling upgrade through; WebRTC media on `27018` stays direct, untouched.

The upstream bundle's filename is content-hashed inside the image, so the image is
**pinned by digest** in `docker-compose.yml`. If you bump the image, re-run
`./prepare-client.sh` to regenerate `web/main.js` and re-sync the filename.

## Important notes

- **The host IP must match `IP:` in `docker-compose.yml`** (WebRTC requirement);
  `./start.sh` updates it on every launch.
- `sv_lan` must stay `0` in `cstrike/server.cfg` — `1` breaks RCON / the map picker.
- Ports: `27016` (HTTP — game page + signaling, served by the nginx proxy), `27018` TCP/UDP
  (WebRTC game traffic, direct to the game container).

### Rebuilding `valve.zip`

`valve.zip` holds the game assets (maps, models, sounds). It is **not** included in this
repo (Valve copyright + size). Normally you don't build it by hand — `./start.sh` extracts
it from the pinned server image automatically on first run. To rebuild it manually from
Valve's free anonymous dedicated-server download (SteamCMD app 90) instead:

```bash
steamcmd +@sSteamCmdForcePlatformType linux +force_install_dir "$(pwd)/hlds" \
  +login anonymous +app_set_config 90 mod cstrike +app_update 90 validate +quit
cd hlds && zip -r ../valve.zip valve cstrike \
  -x "*.so" -x "*.dll" -x "*.exe" -x "*.dylib" -x "valve/dlls/*" -x "*/logs/*"
```

(app 90 is flaky — rerun until it reports success. Do **not** exclude `.lst` files —
the engine crashes on startup without `cstrike/delta.lst`.) After rebuilding, run
`./add-maps.sh` again to re-add the custom maps.

> Note: `start.sh` additionally trims Half-Life single-player maps, intro media and HL-only
> sounds that CS 1.6 never loads (~400 MB → ~210 MB). The manual command above keeps the full
> set — see the exclude list in `start.sh` for the trimmed build.

## Project layout

```
docker-compose.yml     # game service + nginx proxy (image pinned by digest) + volume mounts
start.sh / stop.sh     # launch / stop; start.sh bootstraps client + custom maps
prepare-client.sh      # regenerate the patched web/main.js from the pinned image
add-maps.sh            # download custom maps into valve.zip + custom-maps/
proxy/nginx.conf       # caching reverse-proxy (owns :27016, /websocket passthrough)
cstrike/server.cfg     # full-money arsenal + RCON password for the map picker
web/index.html         # patched client page: join UI + loading + map picker + Esc handling
web/join.js            # join layer: connect + retry + readable errors + bots + F8 log
web/vendor/            # engine extras.pk3 (fonts/menu) + JSZip, served with long caching
web/main.js            # generated, gitignored (run prepare-client.sh)
patch-main.pl          # applies the (tiny) bundle patches; run via prepare-client.sh
watchdog.sh            # auto-recovery loop, started by start.sh (log: watchdog.log)
status.sh              # one-screen health report        (npm run status)
doctor.sh              # "why can't I join?" diagnosis
test-join.js           # headless tests for web/join.js   (npm test)
test-ops.sh            # ops-script tests via a stub docker (npm test)
custom-maps/*.bsp      # bundled custom maps, committed (mounted into the server)
valve.zip              # game content, gitignored (rebuild via SteamCMD)
docs/img/              # screenshots
verify.mjs             # headless e2e smoke test (npm i && node verify.mjs)
```

## Playing from outside the LAN

WebRTC needs direct UDP — an HTTP tunnel (ngrok etc.) won't work. Either forward ports
`27016/tcp` + `27018/tcp+udp` on the router (and set `IP:` to the public IP), or join a
VPN (WireGuard/Tailscale) and set `IP:` to the VPN address.

---

## Credits & attribution

- **Counter-Strike** and **Half-Life** — game, maps, models, sounds and all related
  assets are © **Valve Corporation**. This project is **not affiliated with or endorsed
  by Valve**. Game content (`valve.zip`) is **not** redistributed here; it is downloaded
  on the host from Valve's own anonymous SteamCMD servers.
- **Engine & web client** — [Xash3D FWGS](https://github.com/FWGS/xash3d-fwgs) and the
  [webxash3d-fwgs](https://github.com/yohimik/webxash3d-fwgs) WebAssembly port and Docker
  image (`yohimik/cs-web-server`) by **yohimik**. All credit for the in-browser engine
  goes to those projects; please refer to their repositories for their licenses.
- **`cs_mansion`** — community-made custom map, bundled in `custom-maps/` (originally
  obtained from a public mirror, [DS-Servers](https://ds-servers.com)). All rights to the
  map remain with its original author; it is included here only for convenient LAN play.
- Apart from this one community map, the repository contains only configuration, scripts,
  a small client patch, screenshots, and documentation. It ships **no** Valve content.

## Disclaimer — no warranty, no liability

This project is provided **"as is", without warranty of any kind**, express or implied,
including but not limited to the warranties of merchantability, fitness for a particular
purpose and non-infringement. In no event shall the author be liable for any claim,
damages or other liability arising from, out of, or in connection with the software or
its use.

It is an **unofficial, hobby/educational tool** for running a private LAN game among
people who own Counter-Strike. It is not affiliated with Valve, FWGS, or yohimik. You
are responsible for ensuring your use complies with Valve's EULA/Steam Subscriber
Agreement and any applicable laws in your jurisdiction. Use at your own risk.
