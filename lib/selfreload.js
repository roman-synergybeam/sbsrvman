'use strict';
// The panel picks up its own code changes — nobody has to restart it by hand.
//
// The page is assembled once at boot and the backend is loaded once, so an edit to ui/, lib/ or
// server.js used to do nothing until someone ran `systemctl restart pm2-root` as root. This watches
// those files; once edits have been quiet for a few seconds:
//   * ui/ only  → the page is rebuilt in place (no restart). A UI that does not parse is not served:
//                 the old page stays and the error is logged.
//   * backend   → every changed .js is syntax-checked and loaded in a throwaway node process first;
//                 if any fails, nothing restarts (the running panel keeps working) and the error is
//                 reported once. If all pass, the panel restarts through the same path as an update
//                 from GitHub (waits for running updates and in-flight requests, pm2 restart, checks
//                 it answers again).
// Off with RHC_NO_SELF_RELOAD=1 (and in a dev instance, which rebuilds the page per request anyway).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { APP_ROOT, DEV } = require('./config');

const QUIET_MS = 15000;   // edits come in bursts (several files): apply once they have settled
const pending = new Set();
let timer = null, restarting = false, lastError = null;
let inFlight = 0;

// server.js counts requests so a restart does not cut one off (a GitHub connect can take a minute).
function track(res) { inFlight++; let done = false; const end = () => { if (!done) { done = true; inFlight--; } }; res.on('finish', end); res.on('close', end); }

const relevant = (rel) => /^(lib\/.*\.js|ui\/.*\.(js|html|css)|server\.js)$/.test(rel) && !/\.(tmp|swp)$|~$/.test(rel);

function run(cmd, args, timeout) {
  return new Promise((resolve) => execFile(cmd, args, { cwd: APP_ROOT, timeout: timeout || 30_000, env: Object.assign({}, process.env, { RHC_NO_JOBS: '1' }) },
    (err, stdout, stderr) => resolve({ err, out: ((stderr || '') + (stdout || '')).trim() })));
}

async function check(files) {
  const js = files.filter((f) => f.endsWith('.js') && fs.existsSync(path.join(APP_ROOT, f)));
  for (const f of js) {
    const r = await run(process.execPath, ['--check', f]);
    if (r.err) return f + ' does not parse:\n' + r.out.split('\n').slice(0, 8).join('\n');
  }
  // load the changed backend modules (not server.js: loading it would start a second server)
  const mods = js.filter((f) => f.startsWith('lib/')).map((f) => './' + f);
  if (mods.length) {
    const r = await run(process.execPath, ['-e', 'for (const m of JSON.parse(process.argv[1])) require(m); process.exit(0)', JSON.stringify(mods)], 30_000);
    if (r.err) return 'loading ' + mods.join(', ') + ' failed:\n' + r.out.split('\n').slice(0, 10).join('\n');
  }
  try { require('./page').build(); } catch (e) { return e.message; }
  return null;
}

function report(msg) {
  if (msg === lastError) return;
  lastError = msg;
  console.error('self-reload: ' + msg);
  try { require('./events').emit('panel.reload', { user: 'system', target: 'panel', level: msg ? 'error' : 'info', message: msg ? 'Code change NOT applied — ' + msg.split('\n')[0] : 'Code change applied' }); } catch (_) {}
  if (msg) try { require('./notify').send('⚠️ *Panel code change not applied* — the running panel keeps the old code\n`' + msg.slice(0, 600) + '`', 'complete').catch(() => {}); } catch (_) {}
}

async function apply() {
  timer = null;
  const files = [...pending]; pending.clear();
  if (!files.length || restarting) return;
  const err = await check(files);
  if (err) return report(err);
  const backend = files.some((f) => !f.startsWith('ui/'));
  if (!backend) {
    try { require('./page').reload(); console.log('self-reload: UI rebuilt (' + files.join(', ') + ')'); lastError = null; }
    catch (e) { report(e.message); }
    return;
  }
  const pm2Name = process.env.pm_id !== undefined ? process.env.name : null;
  if (!pm2Name) return report('backend changed (' + files.join(', ') + ') but the panel is not running under pm2 — restart it by hand');
  restarting = true;
  console.log('self-reload: backend changed (' + files.join(', ') + ') — restarting');
  for (let i = 0; i < 60 && inFlight > 0; i++) await new Promise((r) => setTimeout(r, 2000));   // ≤ 2 min for running requests
  const head = await run('git', ['rev-parse', '--short', 'HEAD']);
  require('./updates').restartPanel(pm2Name, null, (head.out || 'working tree') + ' + local changes: ' + files.join(', '));
}

function start() {
  if (DEV || process.env.RHC_NO_SELF_RELOAD) return;
  const watch = (dir, recursive) => {
    try {
      fs.watch(path.join(APP_ROOT, dir), { recursive }, (_ev, name) => {
        if (!name) return;
        const rel = (dir === '.' ? '' : dir + '/') + String(name).split(path.sep).join('/');
        if (!relevant(rel)) return;
        pending.add(rel);
        clearTimeout(timer); timer = setTimeout(() => apply().catch((e) => report(e.message)), QUIET_MS);
      });
    } catch (e) { console.error('self-reload: cannot watch ' + dir + ':', e.message); }
  };
  watch('lib', true); watch('ui', true); watch('.', false);
}

module.exports = { start, track };
