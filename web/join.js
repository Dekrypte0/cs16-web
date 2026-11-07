/*!
 * cs16-web — client join layer (web/join.js)
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 * The upstream web client (yohimik/cs-web-server) boots the Xash3D engine and
 * THEN tries to join the dedicated server. If that join fails for any reason —
 * wrong IP baked into the container, firewall/AP isolation blocking WebRTC, an
 * ICE candidate the browser cannot reach — the engine simply falls back to its
 * own Counter-Strike main menu. Nothing is logged, nothing is shown, and the
 * player thinks the game "did not load". That is the bug this file fixes.
 *
 * It runs as a classic (non-module) script, BEFORE the engine bundle, and:
 *
 *   1. Remembers the server address and the player name (URL query first, then
 *      localStorage, then a `location.hostname:27018` default).
 *   2. Watches the engine console. When the engine is running and the player
 *      asked to join, it issues `connect <host:port>` — with retries.
 *   3. Classifies the engine output as "connected" / "failed", so a dead
 *      connection surfaces as a readable card with the actual reason and the
 *      exact things to check, instead of a silent menu.
 *   4. Offers an offline "play with bots" fallback and keeps a copyable
 *      diagnostic log (?debug=1 or the Diagnostics button / F8).
 *
 * Everything is defensive: the engine bundle is a black box, so every call into
 * `window.__xash` is feature-detected and swallowed on failure. If this script
 * cannot do its job, the game behaves exactly as before.
 *
 * URL options
 *   ?connect=<host[:port]>   server to join (default: this page's host:27018)
 *   ?connect=0               do not join; stay on the main menu
 *   ?name=<nick>             player name
 *   ?bots=1&map=de_dust2&difficulty=2&quota=9
 *                            start an offline bot game instead of joining
 *   ?debug=1                 open the diagnostic log immediately
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------
    var STORE_CFG = 'cs16-web:cfg';

    var DEFAULT_PORT = '27018'; // docker-compose.yml: PORT of the WebRTC bridge

    // --- URL options (defined first: the config below reads them) ---
    var params;
    try {
        params = new URLSearchParams(location.search || '');
    } catch (e) {
        params = null;
    }
    function q(name) {
        try { var v = params && params.get(name); return v === null || v === undefined ? undefined : v; }
        catch (e) { return undefined; }
    }
    function posInt(v, fallback) {
        var n = parseInt(v, 10);
        return isFinite(n) && n > 0 ? n : fallback;
    }
    function truthy(v) { return v !== undefined && !/^(0|false|no|off)$/i.test(String(v)); }

    // --- Tuning ---
    // How many automatic join attempts before we give up and show the card.
    // Overridable (?joinAttempts=N): useful on a slow LAN and for the tests.
    var MAX_ATTEMPTS = posInt(q('joinAttempts'), 3);
    // How long to wait for any engine feedback about one attempt (?joinTimeout=ms).
    var ATTEMPT_TIMEOUT_MS = posInt(q('joinTimeout'), 20000);
    // Delay before the next attempt (?joinRetry=ms).
    var RETRY_DELAY_MS = posInt(q('joinRetry'), 1500);

    // Once the "give up" card has been shown, keep trying in the background so
    // a server that comes back later still picks the player up — but slowly,
    // so a genuinely broken setup is not hammered (?joinIdle=ms).
    var IDLE_RETRY_MS = posInt(q('joinIdle'), 12000);

    // While connected, the player should never be dumped on the menu because of
    // one hiccup: retry a dropped connection, then fall back to the periodic
    // background retry (?joinDrop=<n>).
    var DROP_RETRIES = posInt(q('joinDrop'), 3);

    // Watchdog: if the engine stops responding to our `status` probes while we
    // are supposed to be connected, treat it as a dead join (not just a hiccup).
    var STALL_MS = posInt(q('joinStall'), 45000);
    var PROBE_MS = posInt(q('joinProbe'), 8000);

    // Engine console lines that mean "the join worked".
    var RE_OK = /(connection accepted|serverinfo|server info|loading map|spawn server|hostname:|connected to|"connected")/i;
    // Engine console lines that mean "this attempt failed".
    var RE_FAIL = /(server not responding|remote host|connection timed out|could ?n[o']t connect|no route to host|net_sendpacket.*(fail|error)|net_queuepacket.*error|bad address|invalid address|host_error|disconnected)/i;
    // Console lines that mean "we were in, and now we are not".
    var RE_DROP = /(server shutting down|disconnected|connection (to|was) (the )?(server )?(lost|closed|reset)|reconnect|net_sendpacket.*error|host_error)/i;

    function loadCfg() {
        var cfg = { name: '', server: '', autoConnect: true, explicit: false };
        try {
            var raw = localStorage.getItem(STORE_CFG);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    if (typeof parsed.name === 'string') cfg.name = parsed.name;
                    if (typeof parsed.server === 'string') cfg.server = parsed.server;
                    if (typeof parsed.explicit === 'boolean') cfg.explicit = parsed.explicit;
                    if (typeof parsed.autoConnect === 'boolean') cfg.autoConnect = parsed.autoConnect;
                }
            }
        } catch (e) { /* private mode / corrupted value: ignore */ }
        return cfg;
    }
    function saveCfg() {
        try { localStorage.setItem(STORE_CFG, JSON.stringify(cfg)); } catch (e) {}
    }

    var cfg = loadCfg();

    // Are we playing on the machine that also runs the server? Then the server
    // is reachable on loopback even if this box is not on the LAN (Wi-Fi down,
    // AP isolation, a fresh clone with the compose default IP, ...).
    function isLocalHost() {
        var h = (location.hostname || '').toLowerCase();
        return h === 'localhost' || h === '::1' || h === '[::1]' ||
               h === '127.0.0.1' || /^127\./.test(h);
    }

    // Try these in order until one joins. Loopback first on the host itself.
    function candidateServers() {
        var list = [];
        var auto = defaultServer();
        function add(a) { if (a && list.indexOf(a) === -1) list.push(a); }
        // An address the player chose (URL or the field) always comes first —
        // never silently override an explicit choice. Otherwise, on the server
        // machine itself, loopback is the most likely one to work.
        if (cfg.explicit) add(cfg.server);
        if (isLocalHost()) add('127.0.0.1:' + DEFAULT_PORT);
        add(cfg.server);
        add(auto);
        return list;
    }

    // Default server: the page host IS the machine running the WebRTC bridge
    // (nginx proxy + game container), so this is right for LAN players too.
    function defaultServer() {
        var h = location.hostname || '127.0.0.1';
        return h + ':' + DEFAULT_PORT;
    }

    var urlServer = q('connect');
    if (urlServer !== undefined && String(urlServer).trim() !== '' && truthy(urlServer)) {
        cfg.server = normaliseAddr(urlServer);
        cfg.explicit = true;
    }
    if (q('name') !== undefined) cfg.name = String(q('name')).slice(0, 24);
    var autoConnectParam = q('connect');
    if (autoConnectParam !== undefined && !truthy(autoConnectParam)) cfg.autoConnect = false;

    var botOpts = {
        enabled: truthy(q('bots')),
        map: q('map') || 'de_dust2',
        difficulty: q('difficulty') || '2',
        quota: q('quota') || '9'
    };

    if (!cfg.server) cfg.server = defaultServer();

    // Accept "host", "host:port", "http://host:port" and normalise to host:port.
    function normaliseAddr(v) {
        v = String(v).trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
        if (!v) return defaultServer();
        if (!/:\d+$/.test(v)) v += ':' + DEFAULT_PORT;
        return v;
    }

    // ---------------------------------------------------------------------
    // Diagnostic log (ring buffer, copyable, shown on demand)
    // ---------------------------------------------------------------------
    var LOG_MAX = 600;
    var logLines = [];
    var logOverlay = null;

    function stamp(d) {
        d = d || new Date();
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function logLine(text, kind) {
        var line = { t: stamp(), text: String(text), kind: kind || 'engine' };
        logLines.push(line);
        if (logLines.length > LOG_MAX) logLines.shift();
        if (logOverlay && logOverlay.style.display === 'flex') renderLog();
        return line;
    }

    function renderLog() {
        var box = document.getElementById('cs-joinlog-body');
        if (!box) return;
        box.textContent = logLines.map(function (l) { return '[' + l.t + '] ' + l.text; }).join('\n');
        box.scrollTop = box.scrollHeight;
    }

    // ---------------------------------------------------------------------
    // Small DOM helpers (no dependencies, no framework)
    // ---------------------------------------------------------------------
    function css(el, s) { for (var k in s) el.style[k] = s[k]; }
    function el(tag, props, style) {
        var n = document.createElement(tag);
        if (props) for (var k in props) n[k] = props[k];
        if (style) css(n, style);
        return n;
    }

    // Status strip: shows join progress. Bottom, above the card, never blocks
    // the game (pointer-events none) and only visible while the mouse is free.
    function statusEl() {
        var s = document.getElementById('cs-joinstatus');
        if (!s || !document.body.contains(s)) {
            s = el('div', { id: 'cs-joinstatus' }, {
                position: 'fixed', left: '50%', top: '10px', transform: 'translateX(-50%)',
                zIndex: 2147483644, display: 'none', maxWidth: 'min(94vw, 620px)',
                padding: '8px 16px', background: 'rgba(0,0,0,.82)', color: '#f6b265',
                border: '1px solid #f6b265', borderRadius: '999px',
                font: '600 13px Arial, Helvetica, sans-serif', textAlign: 'center',
                pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden',
                textOverflow: 'ellipsis'
            });
            if (document.body) document.body.appendChild(s);
        }
        return s;
    }

    function setStatus(text, sticky) {
        var s = statusEl();
        if (!s) return;
        if (!text) { s.style.display = 'none'; return; }
        s.textContent = text;
        s.style.display = 'block';
        if (!sticky) {
            clearTimeout(setStatus._t);
            setStatus._t = setTimeout(function () {
                var n = document.getElementById('cs-joinstatus');
                if (n) n.style.display = 'none';
            }, 6000);
        }
    }

    // ---------------------------------------------------------------------
    // Failure card: the whole point. A failed join is never silent again.
    // ---------------------------------------------------------------------
    function showTrouble(reason) {
        var old = document.getElementById('cs-joinhelp');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var overlay = el('div', { id: 'cs-joinhelp' }, {
            position: 'fixed', inset: '0', zIndex: 2147483646, display: 'flex',
            alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.72)',
            fontFamily: 'Arial, Helvetica, sans-serif'
        });

        var panel = el('div', {}, {
            background: '#1b1b1bf2', border: '1px solid #f6b265', borderRadius: '12px',
            padding: '22px 24px', width: '92%', maxWidth: '520px', color: '#ddd',
            boxSizing: 'border-box', boxShadow: '0 10px 50px #000', maxHeight: '88vh', overflow: 'auto'
        });

        panel.appendChild(el('h2', { textContent: 'Could not join the game server' }, {
            color: '#f6b265', margin: '0 0 8px', fontSize: '19px'
        }));

        panel.appendChild(el('p', { innerHTML:
            'The engine started, but it could not reach <b>' + escapeHtml(cfg.server) + '</b>, ' +
            'so Counter-Strike fell back to its own main menu.' +
            (reason ? '<br><span style="color:#9aa0a6">Details: ' + escapeHtml(reason) + '</span>' : '')
        }, { color: '#aaa', margin: '0 0 14px', fontSize: '13px', lineHeight: '1.6' }));

        var ul = el('ul', {}, { margin: '0 0 16px', paddingLeft: '18px', fontSize: '13px', lineHeight: '1.8', color: '#cfcfcf' });
        [
            'The host must be running <b>./start.sh</b> (or the two Docker containers).',
            'This page keeps retrying in the background, so it joins as soon as the server answers.',
            'Everyone must be on the <b>same Wi-Fi/LAN</b>; guest or AP-isolated Wi-Fi blocks WebRTC.',
            'Allow inbound TCP <b>27016</b> and TCP/UDP <b>27018</b> on the host firewall.',
            'If the host\u2019s IP changed, re-run <b>./start.sh</b> so the container advertises the new IP.'
        ].forEach(function (html) {
            var li = document.createElement('li');
            li.innerHTML = html;
            ul.appendChild(li);
        });
        panel.appendChild(ul);

        var row = el('div', {}, { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' });

        var retry = el('button', { textContent: 'Retry', type: 'button' }, {
            background: '#f6b265', color: '#101010', border: 'none', borderRadius: '8px',
            padding: '10px 22px', cursor: 'pointer', font: '700 14px Arial, sans-serif'
        });
        retry.onclick = function () {
            overlay.style.display = 'none';
            resetJoin();
            startJoin();
        };

        var bots = el('button', { textContent: 'Play offline with bots', type: 'button' }, {
            background: 'none', color: '#f6b265', border: '1px solid #f6b265',
            borderRadius: '8px', padding: '9px 16px', cursor: 'pointer', font: '600 13px Arial, sans-serif'
        });
        bots.onclick = function () {
            overlay.style.display = 'none';
            startBots();
        };

        var close = el('button', { textContent: 'Close', type: 'button' }, {
            background: 'none', color: '#999', border: 'none', cursor: 'pointer',
            fontSize: '12px', textDecoration: 'underline', padding: '8px'
        });
        close.onclick = function () { overlay.style.display = 'none'; };

        row.appendChild(retry);
        row.appendChild(bots);
        row.appendChild(close);
        panel.appendChild(row);
        overlay.appendChild(panel);
        (document.body || document.documentElement).appendChild(overlay);
    }

    function hideTrouble() {
        var old = document.getElementById('cs-joinhelp');
        if (old && old.parentNode) old.parentNode.removeChild(old);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------------------------------------------------------------------
    // Engine handle
    // ---------------------------------------------------------------------
    function engine() {
        var x = window.__xash;
        return x && typeof x === 'object' ? x : null;
    }

    function exec(cmd) {
        var x = engine();
        if (!x || typeof x.Cmd_ExecuteString !== 'function') return false;
        try {
            state.cmdAt = Date.now();
            x.Cmd_ExecuteString(cmd);
            logLine('> ' + cmd, 'cmd');
            return true;
        } catch (e) {
            logLine('! command failed: ' + cmd + ' (' + (e && e.message) + ')', 'warn');
            return false;
        }
    }

    // Tap the engine console without stealing it from the page/bundle.
    function hookConsole() {
        var x = engine();
        if (!x || x.__csHooked) return !!x;
        var mod = x.opts && x.opts.module;
        if (!mod || typeof mod !== 'object') return false;
        x.__csHooked = true;
        var prevPrint = mod.print;
        var prevErr = mod.printErr;
        mod.print = function (line) {
            onEngineLine(String(line));
            if (typeof prevPrint === 'function') { try { prevPrint.apply(this, arguments); } catch (e) {} }
        };
        mod.printErr = function (line) {
            onEngineLine(String(line));
            if (typeof prevErr === 'function') { try { prevErr.apply(this, arguments); } catch (e) {} }
        };
        logLine('engine console tapped', 'info');
        return true;
    }

    // ---------------------------------------------------------------------
    // Join state machine
    // ---------------------------------------------------------------------
    var state = {
        // idle | waiting-engine | connecting | connected | failed | bots
        phase: 'idle',
        attempt: 0,
        timer: null,        // pending state-machine step (timeout / retry)
        probeTimer: null,   // periodic "are we still in?" probe
        cmdAt: 0,
        lastReason: '',
        connectedAt: 0,
        lastProbeAt: 0,     // last time we asked the engine for `status`
        lastAliveAt: 0,     // last time the engine said anything while connected
        dropRetries: 0,
        connects: 0,
        probes: 0
    };

    function clearTimer() {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }
    function clearProbe() {
        if (state.probeTimer) { clearInterval(state.probeTimer); state.probeTimer = null; }
    }

    function resetJoin() {
        clearTimer();
        clearProbe();
        state.phase = 'idle';
        state.attempt = 0;
        state.lastReason = '';
        state.dropRetries = 0;
    }

    function onEngineLine(line) {
        logLine(line);

        // Any engine output while connected proves the engine (and usually the
        // connection) is alive; the watchdog below reads lastAliveAt.
        if (state.phase === 'connected') state.lastAliveAt = Date.now();

        // The engine echoes the command we just typed ("> connect 1.2.3.4:5").
        // Ignore exactly that echo briefly, instead of ignoring *everything*
        // for a moment — otherwise a fast real answer would be dropped too.
        var echoed = String(line).trim().replace(/^[>\]]\s*/, '');
        if (state.cmdAt && Date.now() - state.cmdAt < 1200 &&
            echoed.length < 64 && /^(disconnect|connect)\b/i.test(echoed)) {
            return;
        }

        if (state.phase === 'connecting') {
            if (RE_OK.test(line)) {
                markConnected(line);
            } else if (RE_FAIL.test(line)) {
                state.lastReason = line;
                scheduleRetry(400);
            }
            return;
        }

        // Dropped mid-game: an hour of play must survive a hiccup, so retry
        // quietly instead of surfacing the card (the player is in-game and
        // would only see a flash of the menu).
        if (state.phase === 'connected' && RE_DROP.test(line)) {
            onDropped(line);
        }
    }

    function markConnected(why) {
        clearTimer();
        clearProbe();
        state.phase = 'connected';
        state.connectedAt = Date.now();
        state.lastAliveAt = Date.now();
        state.dropRetries = 0;
        setStatus('Connected to ' + cfg.server, false);
        logLine('join OK' + (why ? ' (' + why + ')' : ''), 'info');
        startProbe();
        hideTrouble();
        renderStateCard();
    }

    function onDropped(why) {
        if (state.dropRetries >= DROP_RETRIES) {
            // Out of quiet retries: this is a real outage. Keep the periodic
            // background retry alive so a server restart still reconnects.
            state.phase = 'failed';
            state.lastReason = why;
            logLine('connection lost; giving up after ' + state.dropRetries + ' quiet retries', 'warn');
            renderStateCard();
            setStatus('Disconnected from ' + cfg.server + ' — retrying in background', true);
            scheduleIdleRetry();
            return;
        }
        state.dropRetries += 1;
        state.lastReason = why;
        logLine('connection lost (' + why + ') — quick retry ' + state.dropRetries + '/' + DROP_RETRIES, 'warn');
        setStatus('Connection lost — reconnecting (' + state.dropRetries + '/' + DROP_RETRIES + ')', true);
        clearProbe();
        state.phase = 'connecting';
        state.attempt = 1;
        scheduleRetry(600);
    }

    // Ask the engine, periodically, whether we are still in the game. The
    // engine answers `status` with a printable player list, which also keeps
    // lastAliveAt fresh; silence for STALL_MS means the join went away without
    // the engine saying so (e.g. the packet channel collapsed).
    function startProbe() {
        clearProbe();
        state.lastProbeAt = Date.now();
        state.probeTimer = setInterval(function () {
            if (state.phase !== 'connected') return;
            var now = Date.now();
            // Only probe when the engine has been quiet for a while, so we do
            // not interleave our commands with gameplay chat spam.
            if (now - state.lastAliveAt < STALL_MS / 2) return;
            state.lastProbeAt = now;
            state.probes += 1;
            exec('status');
            setTimeout(function () {
                if (state.phase !== 'connected') return;
                if (Date.now() - state.lastAliveAt > STALL_MS) {
                    onDropped('engine stopped answering (no reply for ' +
                        Math.round(STALL_MS / 1000) + 's)');
                }
            }, 4000);
        }, PROBE_MS);
    }

    // Wait for the engine main loop, then act.
    function waitForEngine(then) {
        state.phase = 'waiting-engine';
        var started = Date.now();
        (function poll() {
            var x = engine();
            if (x && x.running) {
                hookConsole();
                logLine('engine running', 'info');
                then();
                return;
            }
            if (Date.now() - started > 240000) { // 4 min: generous for a first load
                state.phase = 'failed';
                logLine('engine never started', 'warn');
                return;
            }
            state.timer = setTimeout(poll, 250);
        })();
    }

    // --- "this machine is the server" -------------------------------------
    // The host almost always wants to play too, and a fresh clone has the
    // compose IP set to a placeholder. One click starts a local game that needs
    // no WebRTC/LAN at all, so there is always something to play immediately.
    function addLocalCard(form) {
        if (!isLocalHost() || form.querySelector('.cs-local')) return;

        var box = el('div', { className: 'cs-local' }, {
            borderTop: '1px solid #2a2a2a', paddingTop: '12px',
            display: 'flex', flexDirection: 'column', gap: '8px'
        });
        box.appendChild(el('div', { textContent: 'Running on the server machine?' }, {
            fontSize: '12px', color: '#9aa0a6', fontWeight: '600'
        }));

        var local = el('button', {
            type: 'button',
            textContent: '▶ Start a local game (no network needed)'
        }, {
            width: '100%', padding: '11px 14px', background: 'transparent',
            color: '#f6b265', border: '1px solid #f6b265', borderRadius: '10px',
            font: '700 14px Arial, Helvetica, sans-serif', cursor: 'pointer'
        });
        local.onclick = function () {
            var map = (q('map') || 'de_dust2');
            local.textContent = 'Starting ' + map + '…';
            logLine('local game requested (map ' + map + ')', 'info');
            startBots();
        };
        box.appendChild(local);
        box.appendChild(el('div', { textContent:
            'Bots only, on this machine — ideal for a solo test. To play with ' +
            'friends on the Wi-Fi, use Start below.'
        }, { fontSize: '11.5px', color: '#6b7075', lineHeight: '1.5' }));

        var submit = form.querySelector('button[type="submit"]');
        form.insertBefore(box, submit || null);
    }

    // One-line status card: tells the player in plain words what is happening,
    // plus a button to change the server without digging through the console.
    function addStateCard(form) {
        if (form.querySelector('.cs-statecard')) return;
        var box = el('div', { className: 'cs-statecard', id: 'cs-statecard' }, {
            borderTop: '1px solid #2a2a2a', paddingTop: '12px',
            display: 'flex', flexDirection: 'column', gap: '8px'
        });
        var submit = form.querySelector('button[type="submit"]');
        form.insertBefore(box, submit || null);
        renderStateCard();
    }

    function renderStateCard() {
        var box = document.getElementById('cs-statecard');
        if (!box) return;
        var map = { idle: 'Ready.', waiting: 'Starting the engine…',
            connecting: 'Joining the server…', connected: 'Connected.',
            failed: 'Not connected.', bots: 'Local game' };
        var label = map[state.phase] || '';
        box.innerHTML = '';

        var row = el('div', {}, {
            display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px',
            color: state.phase === 'failed' ? '#f0a0a0' : '#9aa0a6'
        });
        var dot = el('span', {}, {
            width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
            background: state.phase === 'connected' ? '#67c07a'
                      : state.phase === 'failed' ? '#c06352'
                      : state.phase === 'connecting' ? '#f6b265' : '#5f6368'
        });
        row.appendChild(dot);
        row.appendChild(el('span', { textContent: label + ' (' + cfg.server + ')' }, {
            flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis'
        }));
        var edit = el('button', { type: 'button', textContent: 'Change' }, {
            background: 'none', border: 'none', color: '#f6b265', cursor: 'pointer',
            fontSize: '12.5px', textDecoration: 'underline', padding: '0'
        });
        edit.onclick = function () {
            var f = document.getElementById('form');
            if (f && f.style.display === 'none') f.style.display = '';
            var inputEl = document.getElementById('cs-server-input');
            if (inputEl) { try { inputEl.focus(); inputEl.select(); } catch (e) {} }
        };
        row.appendChild(edit);
        box.appendChild(row);
    }

    function startJoin() {
        if (state.phase === 'connecting' || state.phase === 'connected') return;
        var name = (cfg.name || '').trim() || readNameFromForm() || 'Player';
        cfg.name = name;
        saveCfg();

        waitForEngine(function () {
            // The engine may drop the join while its own menu initialises;
            // give it a beat, then issue name + connect ourselves.
            setTimeout(function () {
                exec('name "' + name.replace(/"/g, '') + '"');
                state.attempt = 0;
                attemptJoin();
            }, 400);
        });
    }

    function attemptJoin() {
        clearTimer();
        state.attempt += 1;
        state.phase = 'connecting';

        if (state.attempt > MAX_ATTEMPTS) {
            state.phase = 'failed';
            state.lastReason = state.lastReason || 'no response from the server';
            setStatus('Could not reach ' + cfg.server + ' — retrying in background', true);
            showTrouble(state.lastReason);
            scheduleIdleRetry();
            return;
        }

        // Round 1 uses the configured address; later rounds also try the other
        // candidates (loopback when this IS the server, the page's own host).
        // That covers the two classic misconfigurations with no user action.
        var candidates = candidateServers();
        var target = candidates[(state.attempt - 1) % candidates.length] || cfg.server;

        setStatus('Joining ' + target + ' \u2014 attempt ' + state.attempt + '/' + MAX_ATTEMPTS, true);
        logLine('connect attempt ' + state.attempt + '/' + MAX_ATTEMPTS + ' -> ' + target, 'info');

        if (state.attempt > 1) exec('disconnect');
        state.connects += 1;
        if (!exec('connect ' + target)) {
            state.phase = 'failed';
            showTrouble('the engine console is not available (window.__xash is missing) ' +
                '\u2014 regenerate the client bundle with ./prepare-client.sh');
            return;
        }
        renderStateCard();

        state.timer = setTimeout(function () {
            if (state.phase !== 'connecting') return;
            state.lastReason = 'no response after ' + Math.round(ATTEMPT_TIMEOUT_MS / 1000) + 's';
            attemptJoin();
        }, ATTEMPT_TIMEOUT_MS);
    }

    function scheduleRetry(ms) {
        clearTimer();
        state.timer = setTimeout(function () {
            if (state.phase === 'connecting') attemptJoin();
        }, ms || RETRY_DELAY_MS);
    }

    // Slow, endless retry used after the card has been shown: if the player
    // leaves the tab open, a server that comes back (host restarted ./start.sh,
    // laptop rejoined the Wi-Fi, ...) still gets them into the game.
    function scheduleIdleRetry() {
        clearTimer();
        state.timer = setTimeout(function () {
            if (state.phase !== 'failed') return;
            if (!engine() || !engine().running) { scheduleIdleRetry(); return; }
            logLine('background retry', 'info');
            state.attempt = 0;
            attemptJoin();
        }, IDLE_RETRY_MS);
    }

    // ---------------------------------------------------------------------
    // Offline / bots mode
    // ---------------------------------------------------------------------
    function startBots() {
        state.phase = 'bots';
        clearTimer();
        var name = (cfg.name || '').trim() || readNameFromForm() || 'Player';
        saveCfg();

        waitForEngine(function () {
            exec('name "' + name.replace(/"/g, '') + '"');
            exec('sv_cheats 0');
            exec('bot_difficulty ' + botOpts.difficulty);
            exec('bot_quota_mode fill');
            setStatus('Starting an offline bot game on ' + botOpts.map + '\u2026', true);
            exec('map ' + botOpts.map);
            // Bots only exist once the map is up; add them shortly after.
            setTimeout(function () {
                exec('bot_quota ' + botOpts.quota);
                for (var i = 0; i < Number(botOpts.quota || 9); i++) {
                    exec('bot_add');
                }
                setStatus('Offline game \u2014 bots added', false);
            }, 6000);
        });
    }

    // ---------------------------------------------------------------------
    // The join card: prefill + server field + extras
    // ---------------------------------------------------------------------
    function readNameFromForm() {
        var input = document.getElementById('username');
        return input && input.value ? String(input.value).trim() : '';
    }

    function writeNameToForm(name) {
        var input = document.getElementById('username');
        if (input && !input.value) input.value = name;
    }

    // Add our controls to the engine's own join card (we deliberately do not
    // replace it: the bundle's submit handler is what boots the game).
    function decorateForm() {
        var form = document.getElementById('form');
        if (!form || form.getAttribute('data-cs-joined') === '1') return;
        form.setAttribute('data-cs-joined', '1');

        writeNameToForm(cfg.name || '');

        var box = el('div', {}, { display: 'flex', flexDirection: 'column', gap: '6px' });

        var label = el('label', { htmlFor: 'cs-server-input', textContent: 'Server (host:port)' }, {
            fontSize: '12px', color: '#9aa0a6', fontWeight: '600'
        });
        var input = el('input', { id: 'cs-server-input', type: 'text', value: cfg.server, spellcheck: false, autocomplete: 'off' }, {
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', background: '#101010',
            color: '#f2f2f2', border: '1px solid #2a2a2a', borderRadius: '10px',
            font: '15px Arial, sans-serif', outline: 'none'
        });
        input.oninput = function () { cfg.server = input.value; };
        input.onblur = function () {
            cfg.server = normaliseAddr(input.value);
            input.value = cfg.server;
            cfg.explicit = true;
            saveCfg();
        };

        var autoRow = el('label', {}, {
            display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px',
            color: '#9aa0a6', cursor: 'pointer', marginTop: '2px'
        });
        var auto = el('input', { type: 'checkbox', checked: cfg.autoConnect }, { width: '16px', height: '16px', margin: '0', accentColor: '#f6b265' });
        auto.onchange = function () { cfg.autoConnect = auto.checked; saveCfg(); };
        autoRow.appendChild(auto);
        autoRow.appendChild(el('span', { textContent: 'Join the server automatically after loading' }));

        box.appendChild(label);
        box.appendChild(input);
        box.appendChild(autoRow);

        var links = el('div', {}, { display: 'flex', gap: '14px', justifyContent: 'center', marginTop: '2px' });
        var botsBtn = el('button', { type: 'button', textContent: 'Play offline with bots' }, {
            background: 'none', border: 'none', color: '#f6b265', cursor: 'pointer',
            fontSize: '12.5px', textDecoration: 'underline', padding: '2px'
        });
        botsBtn.onclick = function () { startBots(); };
        var logBtn = el('button', { type: 'button', textContent: 'Diagnostics' }, {
            background: 'none', border: 'none', color: '#9aa0a6', cursor: 'pointer',
            fontSize: '12.5px', textDecoration: 'underline', padding: '2px'
        });
        logBtn.onclick = function () { toggleLog(true); };
        links.appendChild(botsBtn);
        links.appendChild(logBtn);

        // Insert just above the submit button so the card keeps its layout.
        var submit = form.querySelector('button[type="submit"]') || form.lastChild;
        form.insertBefore(box, submit);
        form.insertBefore(links, submit);
        addStateCard(form);
        addLocalCard(form);

        // Capture the name on submit; the engine's own handler starts the game.
        if (!form.__csHooked) {
            form.__csHooked = true;
            form.addEventListener('submit', function () {
                var typed = readNameFromForm();
                if (typed) cfg.name = typed;
                var sv = document.getElementById('cs-server-input');
                if (sv) cfg.server = normaliseAddr(sv.value);
                saveCfg();
                logLine('join card submitted (name="' + cfg.name + '", server=' + cfg.server + ')', 'info');
                // The engine starts from its own handler; we ask it to join.
                setTimeout(function () { if (cfg.autoConnect) { resetJoin(); startJoin(); } }, 900);
            }, false);
        }
    }

    // ---------------------------------------------------------------------
    // Diagnostic log overlay
    // ---------------------------------------------------------------------
    function toggleLog(show) {
        if (!logOverlay) {
            logOverlay = el('div', { id: 'cs-joinlog' }, {
                position: 'fixed', inset: '0', zIndex: 2147483647, display: 'none',
                alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.75)',
                fontFamily: 'Arial, Helvetica, sans-serif'
            });
            var panel = el('div', {}, {
                background: '#141414f7', border: '1px solid #f6b265', borderRadius: '12px',
                width: '92%', maxWidth: '760px', maxHeight: '84vh', display: 'flex',
                flexDirection: 'column', padding: '16px 18px', boxSizing: 'border-box'
            });
            var head = el('div', {}, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' });
            head.appendChild(el('h2', { textContent: 'Connection diagnostics' }, { color: '#f6b265', margin: '0', fontSize: '17px' }));
            var close = el('button', { textContent: '\u2715', type: 'button' }, {
                background: 'none', border: 'none', color: '#999', fontSize: '20px', cursor: 'pointer'
            });
            close.onclick = function () { toggleLog(false); };
            head.appendChild(close);

            var meta = el('div', { id: 'cs-joinlog-meta' }, { color: '#9aa0a6', fontSize: '12px', lineHeight: '1.6', marginBottom: '10px' });

            var body = el('pre', { id: 'cs-joinlog-body' }, {
                margin: '0', padding: '10px', background: '#0b0b0b', border: '1px solid #2a2a2a',
                borderRadius: '8px', color: '#cfcfcf', fontSize: '11.5px', lineHeight: '1.5',
                overflow: 'auto', flex: '1 1 auto', minHeight: '180px', whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
            });

            var foot = el('div', {}, { display: 'flex', gap: '10px', marginTop: '12px', alignItems: 'center' });
            var copy = el('button', { textContent: 'Copy log', type: 'button' }, {
                background: '#f6b265', color: '#101010', border: 'none', borderRadius: '8px',
                padding: '8px 18px', cursor: 'pointer', font: '700 13px Arial, sans-serif'
            });
            copy.onclick = function () {
                var text = logLines.map(function (l) { return '[' + l.t + '] ' + l.text; }).join('\n');
                try {
                    navigator.clipboard.writeText(text).then(function () {
                        copy.textContent = 'Copied';
                        setTimeout(function () { copy.textContent = 'Copy log'; }, 1500);
                    }, function () { window.prompt('Copy the log:', text); });
                } catch (e) { window.prompt('Copy the log:', text); }
            };
            var retry = el('button', { textContent: 'Retry join', type: 'button' }, {
                background: 'none', color: '#f6b265', border: '1px solid #f6b265', borderRadius: '8px',
                padding: '7px 16px', cursor: 'pointer', font: '600 13px Arial, sans-serif'
            });
            retry.onclick = function () { resetJoin(); startJoin(); };
            foot.appendChild(copy);
            foot.appendChild(retry);

            panel.appendChild(head);
            panel.appendChild(meta);
            panel.appendChild(body);
            panel.appendChild(foot);
            logOverlay.appendChild(panel);
            logOverlay.onclick = function (e) { if (e.target === logOverlay) toggleLog(false); };
        }
        (document.body || document.documentElement).appendChild(logOverlay);
        logOverlay.style.display = show ? 'flex' : 'none';
        if (show) {
            var meta = document.getElementById('cs-joinlog-meta');
            if (meta) {
                meta.innerHTML =
                    'Page: <b>' + escapeHtml(location.origin) + '</b><br>' +
                    'Server address: <b>' + escapeHtml(cfg.server) + '</b><br>' +
                    'Engine: ' + (engine() ? (engine().running ? 'running' : 'loaded, not running') : 'not loaded') +
                    ' &middot; join phase: <b>' + state.phase + '</b>';
            }
            renderLog();
        }
    }

    // F8 toggles the log; the classic GoldSrc console key (~) is left alone.
    window.addEventListener('keydown', function (e) {
        if (e.key === 'F8') { toggleLog(logOverlay && logOverlay.style.display === 'flex' ? false : true); }
    }, true);

    // ---------------------------------------------------------------------
    // Boot: keep our UI alive across <body> rebuilds by the engine
    // ---------------------------------------------------------------------
    var booted = false;

    function tick() {
        if (!document.body) return;
        decorateForm();
        statusEl();
        if (!booted) {
            booted = true;
            logLine('join layer ready; server=' + cfg.server + ' autoConnect=' + cfg.autoConnect, 'info');
            if (truthy(q('debug'))) toggleLog(true);

            // ?bots=1 starts an offline game straight away. Joining a server
            // waits for the player to submit the card: browsers only hand out
            // audio + pointer lock from a user gesture, so auto-submitting would
            // boot the engine muted and unfocused.
            if (botOpts.enabled) startBots();
        }
        // While the engine is running and we are mid-join, keep the status
        // strip out of the way of gameplay.
        renderStateCard();
        var s = document.getElementById('cs-joinstatus');
        if (s && s.style.display !== 'none' && document.pointerLockElement) s.style.display = 'none';
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tick);
    } else {
        tick();
    }
    setInterval(tick, 800);

    // Public hooks (also useful from the browser console and for tests).
    window.__csJoin = {
        config: cfg,
        state: state,
        connect: function (addr) {
            if (addr) cfg.server = normaliseAddr(addr);
            saveCfg();
            resetJoin();
            startJoin();
        },
        bots: function (map) { if (map) botOpts.map = map; startBots(); },
        log: function () { return logLines.map(function (l) { return '[' + l.t + '] ' + l.text; }).join('\n'); },
        showLog: toggleLog
    };
})();
