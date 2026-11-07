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

    // Engine console lines that mean "the join worked".
    var RE_OK = /(connection accepted|serverinfo|server info|loading map|spawn server|hostname:|connected to|"connected")/i;
    // Engine console lines that mean "this attempt failed".
    var RE_FAIL = /(server not responding|remote host|connection timed out|could ?n[o']t connect|no route to host|net_sendpacket.*(fail|error)|net_queuepacket.*error|bad address|invalid address|host_error|disconnected)/i;

    function loadCfg() {
        var cfg = { name: '', server: '', autoConnect: true };
        try {
            var raw = localStorage.getItem(STORE_CFG);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    if (typeof parsed.name === 'string') cfg.name = parsed.name;
                    if (typeof parsed.server === 'string') cfg.server = parsed.server;
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

    // Default server: the page host IS the machine running the WebRTC bridge
    // (nginx proxy + game container), so this is right for LAN players too.
    function defaultServer() {
        var h = location.hostname || '127.0.0.1';
        return h + ':' + DEFAULT_PORT;
    }

    var urlServer = q('connect');
    if (urlServer !== undefined && String(urlServer).trim() !== '' && truthy(urlServer)) {
        cfg.server = normaliseAddr(urlServer);
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
        phase: 'idle',      // idle | waiting-engine | connecting | connected | failed | bots
        attempt: 0,
        timer: null,
        cmdAt: 0,
        lastReason: ''
    };

    function clearTimer() {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }

    function resetJoin() {
        clearTimer();
        state.phase = 'idle';
        state.attempt = 0;
        state.lastReason = '';
    }

    function onEngineLine(line) {
        logLine(line);
        // The engine echoes the command we just typed ("> connect 1.2.3.4:5").
        // Ignore exactly that echo briefly, instead of ignoring *everything*
        // for a moment — otherwise a fast real answer would be dropped too.
        var echoed = String(line).trim().replace(/^[>\]]\s*/, '');
        if (state.cmdAt && Date.now() - state.cmdAt < 1200 &&
            echoed.length < 64 && /^(disconnect|connect)\b/i.test(echoed)) {
            return;
        }
        if (state.phase !== 'connecting') return;
        if (RE_OK.test(line)) {
            markConnected(line);
        } else if (RE_FAIL.test(line)) {
            state.lastReason = line;
            scheduleRetry(400);
        }
    }

    function markConnected() {
        clearTimer();
        state.phase = 'connected';
        setStatus('Connected to ' + cfg.server, false);
        logLine('join OK', 'info');
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
            showTrouble(state.lastReason || 'no response from the server');
            return;
        }

        setStatus('Joining ' + cfg.server + ' \u2014 attempt ' + state.attempt + '/' + MAX_ATTEMPTS, true);
        logLine('connect attempt ' + state.attempt + ' -> ' + cfg.server, 'info');

        if (state.attempt > 1) exec('disconnect');
        if (!exec('connect ' + cfg.server)) {
            state.phase = 'failed';
            showTrouble('the engine console is not available (window.__xash missing)');
            return;
        }

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
        input.onblur = function () { cfg.server = normaliseAddr(input.value); input.value = cfg.server; saveCfg(); };

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
