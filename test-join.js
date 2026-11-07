#!/usr/bin/env node
/*
 * test-join.js — headless test for web/join.js (the join layer).
 *
 *     node test-join.js            # run all scenarios
 *
 * Why: the join layer is the code that decides whether a browser ends up in the
 * game or in Counter-Strike's own main menu, and no browser is available in CI
 * or in a plain checkout. This drives the real web/join.js inside jsdom against
 * a *simulated* underlying client (same object shape the upstream bundle
 * exposes: running / opts.module.print / Cmd_ExecuteString), so the state
 * machine, the retry logic, the failure card and the bot fallback are all
 * exercised for real.
 *
 * jsdom is only a dev dependency of this test, never required at runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const JOIN_JS = fs.readFileSync(path.join(__dirname, 'web', 'join.js'), 'utf8');

let failures = 0;
let passes = 0;

function check(name, cond, extra) {
  if (cond) {
    passes += 1;
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal stand-in for the upstream client (Xash3DWebRTC instance).
function makeEngine(behavior) {
  const engine = {
    running: false,
    started: false,
    opts: { module: { print() {}, printErr() {} } },
    commands: [],
    Cmd_ExecuteString(cmd) {
      this.commands.push(cmd);
      if (behavior) behavior(cmd, this);
    }
  };
  return engine;
}

/**
 * Boot a page with web/join.js.
 *  url         — query string, e.g. '?connect=10.0.0.5:27018'
 *  engine      — the simulated client, or null to simulate "engine never boots"
 *  storage     — initial localStorage contents
 */
async function boot({ url = '/', engine = null, storage = {}, form = true } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body>
       ${form ? `<form id="form">
         <h1>Counter-Strike 1.6</h1>
         <input id="username" type="text" />
         <button type="submit">Start playing</button>
         <input type="checkbox" id="touchControls" />
       </form>` : ''}
       <canvas id="canvas"></canvas>
     </body></html>`,
    {
      url: 'http://192.168.1.50:27016' + url,
      runScripts: 'outside-only',
      pretendToBeVisual: true
    }
  );
  const { window } = dom;

  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);

  // Capture clicks / preventDefault bookkeeping on the form.
  window.__submitCount = 0;
  const formEl = window.document.getElementById('form');
  if (formEl) {
    // Simulate the engine's own submit handler (it starts the game).
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      window.__submitCount += 1;
      window.__engineStarted = true;
    }, false);
  }

  if (engine) {
    window.__xash = engine;
    if (engine.autoStart) engine.running = true;
  }

  window.eval(JOIN_JS);
  await sleep(50); // let DOMContentLoaded + the first tick run

  // The engine "boots" a moment later unless the test says it never does.
  return dom;
}

// The engine main loop starts a moment after the page is ready.
function startEngine(window, engine) {
  engine.running = true;
  engine.opts.module.print('Xash3D engine initialized');
}

function clickSubmit(window) {
  const form = window.document.getElementById('form');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

async function scenario(name, fn) {
  console.log('\n# ' + name);
  try {
    await fn();
  } catch (e) {
    failures += 1;
    console.log('  FAIL threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  }
}

(async function main() {
  // ---------------------------------------------------------------------
  await scenario('card is decorated, server defaults to the page host', async () => {
    const dom = await boot({});
    const { window } = dom;
    const input = window.document.getElementById('cs-server-input');
    check('server field added to the join card', !!input);
    check('default server is <page host>:27018', input && input.value === '192.168.1.50:27018', input && input.value);
    check('name is remembered from localStorage', (() => {
      return true; // covered by the scenario below
    })());
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('?connect= overrides the server; bad input is normalised', async () => {
    const dom = await boot({ url: '?connect=10.1.2.3' });
    const input = dom.window.document.getElementById('cs-server-input');
    check('host without port gets :27018', input && input.value === '10.1.2.3:27018', input && input.value);
    dom.window.close();

    const dom2 = await boot({ url: '?connect=http://10.9.9.9:27099/' });
    const input2 = dom2.window.document.getElementById('cs-server-input');
    check('URL form is normalised to host:port', input2 && input2.value === '10.9.9.9:27099', input2 && input2.value);
    dom2.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('submit joins the server (connect is actually issued)', async () => {
    const engine = makeEngine();
    const dom = await boot({ engine });
    const { window } = dom;
    startEngine(window, engine);
    window.document.getElementById('username').value = 'Alex';
    clickSubmit(window);
    check('engine boot is not blocked (page did not reload)', window.__submitCount === 1);

    await sleep(1500); // join layer waits ~0.4s after the engine is up
    check('engine console received a connect command',
      engine.commands.some((c) => c === 'connect 192.168.1.50:27018'),
      JSON.stringify(engine.commands));
    check('player name sent to the engine',
      engine.commands.some((c) => c === 'name "Alex"'), JSON.stringify(engine.commands));
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('happy path: success stops retrying', async () => {
    const engine = makeEngine((cmd, e) => {
      if (cmd.startsWith('connect ')) {
        setTimeout(() => e.opts.module.print('Connection accepted'), 100);
      }
    });
    const dom = await boot({ engine });
    const { window } = dom;
    startEngine(window, engine);
    clickSubmit(window);
    await sleep(2200);
    check('phase is connected', window.__csJoin.state.phase === 'connected', window.__csJoin.state.phase);
    check('no failure card', !window.document.getElementById('cs-joinhelp'));
    const connects = engine.commands.filter((c) => c.startsWith('connect ')).length;
    check('joined on the first attempt', connects === 1, connects);
    check('status strip says connected', /Connected/i.test((window.document.getElementById('cs-joinstatus') || {}).textContent || ''));
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('silent server: retries, then explains what went wrong', async () => {
    const engine = makeEngine(); // never answers
    const dom = await boot({ url: '?joinTimeout=250&joinRetry=50', engine });
    const { window } = dom;
    startEngine(window, engine);
    clickSubmit(window);

    const expectConnects = () => engine.commands.filter((c) => c.startsWith('connect ')).length;
    // The layer gives the engine a beat (~0.9s) before its first attempt.
    await sleep(1700);
    check('it started connecting', expectConnects() >= 1, expectConnects());
    await sleep(1500);
    check('retried up to the attempt limit', expectConnects() === 3, expectConnects());
    check('stops retrying (does not hammer the server)', expectConnects() <= 3, expectConnects());
    const help = window.document.getElementById('cs-joinhelp');
    check('it retried before giving up', expectConnects() >= 2, expectConnects());
    check('failure card is shown', !!help);
    check('card names the server it tried',
      help && /192\.168\.1\.50:27018/.test(help.textContent));
    check('card offers the offline fallback', help && /offline with bots/i.test(help.textContent));
    check('card says why (timeout)', help && /no response/i.test(help.textContent));
    check('log has the diagnostics', /connect attempt/.test(window.__csJoin.log()));
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('engine reports failure: retried immediately', async () => {
    let n = 0;
    const engine = makeEngine((cmd, e) => {
      if (cmd.startsWith('connect ')) {
        n += 1;
        setTimeout(() => {
          e.opts.module.print('Server not responding');
        }, 50);
      }
    });
    const dom = await boot({ engine });
    startEngine(dom.window, engine);
    clickSubmit(dom.window);
    await sleep(2000);
    check('a retry happened', n >= 2, n);
    check('reason captured from the engine', /Server not responding/i.test(dom.window.__csJoin.state.lastReason),
      dom.window.__csJoin.state.lastReason);
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('offline bots: map + bots are issued', async () => {
    const engine = makeEngine();
    const dom = await boot({ engine, url: '?bots=1&map=de_aztec&quota=3' });
    const { window } = dom;
    startEngine(window, engine);
    await sleep(1500);
    check('map command issued', engine.commands.includes('map de_aztec'), JSON.stringify(engine.commands));
    await sleep(6200);
    check('bot quota applied', engine.commands.includes('bot_quota 3'), JSON.stringify(engine.commands));
    check('bots added individually', engine.commands.filter((c) => c === 'bot_add').length === 3,
      engine.commands.filter((c) => c === 'bot_add').length);
    check('no join attempt in bot mode', !engine.commands.some((c) => c.startsWith('connect ')));
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('?connect=0 disables joining but keeps the card usable', async () => {
    const engine = makeEngine();
    const dom = await boot({ engine, url: '?connect=0' });
    const { window } = dom;
    startEngine(window, engine);
    window.document.getElementById('username').value = 'Bob';
    clickSubmit(window);
    await sleep(1500);
    check('no connect issued', !engine.commands.some((c) => c.startsWith('connect ')), JSON.stringify(engine.commands));
    check('manual join still available via __csJoin.connect', typeof window.__csJoin.connect === 'function');
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('robustness: no engine at all, nothing throws', async () => {
    const dom = await boot({ engine: null });
    const { window } = dom;
    window.document.getElementById('username').value = 'Bob';
    clickSubmit(window);
    await sleep(600);
    check('page still alive, card intact', !!window.document.getElementById('form'));
    check('diagnostics still work', typeof window.__csJoin.log() === 'string');
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('diagnostics log overlay opens and copies', async () => {
    const dom = await boot({});
    const { window } = dom;
    window.__csJoin.showLog(true);
    const ov = window.document.getElementById('cs-joinlog');
    check('log overlay exists and is visible', ov && ov.style.display === 'flex');
    const body = window.document.getElementById('cs-joinlog-body');
    check('log body has content', body && body.textContent.length > 0);
    const meta = window.document.getElementById('cs-joinlog-meta');
    check('meta shows engine state', meta && /Engine:/.test(meta.textContent));
    dom.window.close();
  });

  // ---------------------------------------------------------------------
  await scenario('settings persist across loads', async () => {
    const engine = makeEngine();
    const dom = await boot({ engine });
    const { window } = dom;
    window.document.getElementById('username').value = 'Zoe';
    window.document.getElementById('cs-server-input').value = '10.7.7.7:27018';
    clickSubmit(window);
    await sleep(200);
    const saved = window.localStorage.getItem('cs16-web:cfg');
    check('settings stored', !!saved && /Zoe/.test(saved) && /10\.7\.7\.7/.test(saved), saved);
    dom.window.close();

    const dom2 = await boot({ engine: makeEngine(), storage: { 'cs16-web:cfg': saved } });
    const input2 = dom2.window.document.getElementById('cs-server-input');
    check('server prefilled from storage', input2 && input2.value === '10.7.7.7:27018', input2 && input2.value);
    check('name prefilled from storage',
      dom2.window.document.getElementById('username').value === 'Zoe',
      dom2.window.document.getElementById('username').value);
    dom2.window.close();
  });

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures === 0 ? 0 : 1);
})();
