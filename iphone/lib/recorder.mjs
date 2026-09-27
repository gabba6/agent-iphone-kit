// Recorder core: starts the USB helper detached (directly or via the app wrapper), keeps its state in files
// (works across processes: CLI start and stop are separate invocations), remuxes to MP4 after the stop,
// keeps only the MP4 and analyzes frame rate and frame changes.
import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, readdir, stat, statfs, unlink, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_RECORDINGS, HELPER_BIN, HELPER_APP, ensurePath, sleep, nowMs, run, mustRun, codeError } from './util.mjs';
import * as A from './analyze.mjs';

export const MARKER = 'iphone-capture/1';
export const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const ACTIVE = new Set(['starting', 'recording', 'stopping']);
const MB = 1048576;

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function newId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readEvents(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function createRecorder(opts = {}) {
  ensurePath();
  const root = resolve(opts.root ?? process.env.IPHONE_RECORDINGS_DIR ?? DEFAULT_RECORDINGS);
  const helper = opts.helper ?? process.env.IPHONE_CAPTURE_HELPER ?? HELPER_BIN;
  const app = opts.app ?? HELPER_APP;
  const launchDefault = opts.launch ?? process.env.IPHONE_CAPTURE_LAUNCH ?? 'auto';
  const limits = {
    maxDays: opts.maxDays ?? envNum('IPHONE_RECORDINGS_MAX_DAYS', 14),
    maxBytes: (opts.maxGB ?? envNum('IPHONE_RECORDINGS_MAX_GB', 5)) * 1024 * MB,
    minFreeBytes: (opts.minFreeMB ?? envNum('IPHONE_MIN_FREE_MB', 1024)) * MB,
  };
  const T = { start: 25000, access: 120000, stop: 20000, poll: 20, ...opts.timeouts };
  const CLIP_RESERVE_S = opts.clipReserveS ?? 8;
  const CLIP_TAIL_MS = opts.clipTailMs ?? 1200; // keep recording at least this long after the action ends
  // About 0.9 s after a recording ends, the iPhone switches its USB configuration back (7 -> 6, measured). A helper
  // started inside this window does not see the screen source for more than 20 s (no_device), and an agent-device
  // command that falls into the switch hangs for 6-8 s or fails (socket hang up). Therefore: wait until SETTLE_MS
  // after the helper exited before clip/stop return and before a new helper starts.
  const SETTLE_MS = opts.settleMs ?? envNum('IPHONE_CAPTURE_SETTLE_MS', 2000);
  const NO_DEVICE_RETRIES = opts.noDeviceRetries ?? 2; // fresh helper if the source is still missing
  // Measured: if a start does hit the switch window, the source stays invisible for 1-2 min and every further attempt
  // extends that. The helper's own message ("unlock the iPhone ...") is misleading in that case.
  const NO_DEVICE_HINT = ' Ist das iPhone entsperrt und per USB verbunden, ist die Bildschirmquelle nach einer USB-Umschaltung blockiert: 1-2 min keine Aufnahme starten, dann einmal erneut versuchen.';
  const currentPath = join(root, '.current');
  const exitPath = join(root, '.helper-exit'); // wall clock (ms) when the last helper exited after opening the source
  const appOkPath = opts.appOkPath ?? join(dirname(app), '.app-access.json'); // consent belongs to the app, not to the recordings folder
  const dirOf = id => join(root, id);
  const recPath = id => join(dirOf(id), 'recording.json');

  async function loadRec(id) {
    if (!ID_RE.test(id)) throw codeError('bad_args', `Ungueltige Aufnahme-ID: ${id}`);
    let rec;
    try { rec = JSON.parse(await readFile(recPath(id), 'utf8')); } catch { throw codeError('not_found', `Aufnahme ${id} nicht gefunden in ${root}.`); }
    if (rec.tool !== MARKER) throw codeError('not_found', `${id} ist keine Aufnahme dieses Werkzeugs.`);
    return rec;
  }
  async function saveRec(rec) {
    const tmp = recPath(rec.id) + '.tmp';
    await writeFile(tmp, JSON.stringify(rec, null, 1), { mode: 0o600 });
    await rename(tmp, recPath(rec.id));
  }
  function currentId() {
    try { const id = readFileSync(currentPath, 'utf8').trim(); return ID_RE.test(id) ? id : null; } catch { return null; }
  }
  async function clearCurrent(id) {
    if (currentId() === id) await unlink(currentPath).catch(() => {});
  }

  // All own recordings (only folders with recording.json and marker), newest first.
  async function listOwn() {
    let names = [];
    try { names = await readdir(root); } catch { return []; }
    const out = [];
    for (const name of names.filter(n => ID_RE.test(n))) {
      try {
        const rec = JSON.parse(await readFile(recPath(name), 'utf8'));
        if (rec.tool === MARKER && rec.id === name) out.push(rec);
      } catch { /* fremder oder defekter Ordner: nie anfassen */ }
    }
    return out.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  async function dirSize(dir) {
    let total = 0;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else total += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
    return total;
  }

  // Cleanup only in its own output folder and only own recordings: older than maxDays, then oldest until <= maxBytes.
  // Never the running recording, never folders containing a ".keep" file.
  async function cleanup({ dryRun = false } = {}) {
    const own = await listOwn();
    const active = currentId();
    const realRoot = realpathSync(root);
    const items = [];
    for (const rec of own) {
      if (rec.id === active || ACTIVE.has(rec.status)) continue;
      if (existsSync(join(dirOf(rec.id), '.keep'))) continue;
      items.push({ id: rec.id, created: Date.parse(rec.created), size: await dirSize(dirOf(rec.id)) });
    }
    const now = Date.now(), removed = [];
    const old = items.filter(i => now - i.created > limits.maxDays * 86400000);
    let rest = items.filter(i => !old.includes(i)).sort((a, b) => a.created - b.created);
    let total = rest.reduce((s, i) => s + i.size, 0);
    const victims = [...old];
    while (total > limits.maxBytes && rest.length) { const v = rest.shift(); total -= v.size; victims.push(v); }
    for (const v of victims) {
      const dir = dirOf(v.id);
      const real = realpathSync(dir);
      if (!real.startsWith(realRoot + '/') || !existsSync(join(real, 'recording.json'))) continue;
      if (!dryRun) await rm(real, { recursive: true, force: true });
      removed.push({ id: v.id, size: v.size, reason: old.includes(v) ? `aelter als ${limits.maxDays} Tage` : `Gesamtgroesse > ${(limits.maxBytes / 1024 / MB).toFixed(1)} GB` });
    }
    return { removed, kept_bytes: total, dry_run: dryRun };
  }

  async function diskFree() {
    const s = await statfs(root);
    return Number(s.bavail) * Number(s.bsize);
  }

  async function ensureTools() {
    for (const t of ['ffmpeg', 'ffprobe']) {
      const r = await run(t, ['-version'], { timeout: 10000 });
      if (r.code !== 0) throw codeError('missing_tool', `${t} fehlt (brew install ffmpeg).`);
    }
    if (!existsSync(helper)) throw codeError('missing_helper', `USB-Helfer fehlt: ${helper}. Bauen mit: zsh ${resolve(helper, '../../build.sh')}`);
  }

  // Finish a recording that ended but was not converted yet (e.g. time limit reached without a stop call).
  async function settleStale() {
    const id = currentId();
    if (!id) return null;
    let rec;
    try { rec = await loadRec(id); } catch { await unlink(currentPath).catch(() => {}); return null; }
    if (ACTIVE.has(rec.status) && pidAlive(rec.pid)) return rec; // really running
    if (rec.status === 'starting' && !rec.pid && Date.now() - Date.parse(rec.created) < T.start + 5000) return rec;
    return finalize(rec, { analyze: false, timeoutMs: 3000 }).catch(() => null).finally(() => clearCurrent(id));
  }

  async function markHelperExit(t = nowMs()) {
    await writeFile(exitPath, String(Math.round(t)), { mode: 0o600 }).catch(() => {});
  }
  // Waits until the USB switch after the last helper exit is over. Returns the waiting time in ms.
  async function waitSettled() {
    let t;
    try { t = Number(readFileSync(exitPath, 'utf8')); } catch { return 0; }
    const wait = Number.isFinite(t) ? t + SETTLE_MS - nowMs() : 0;
    if (wait <= 0 || wait > SETTLE_MS + 1000) return 0;
    await sleep(wait);
    return Math.round(wait);
  }

  function appConsent() {
    try { return JSON.parse(readFileSync(appOkPath, 'utf8')); } catch { return null; }
  }

  // capSeconds: maximum duration for the helper (default = seconds); clip() adds a reserve and stops by itself.
  async function start({ seconds = 10, launch = launchDefault, onEvent, capSeconds = seconds } = {}) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw codeError('bad_args', 'seconds: 1 bis 120 erwartet.');
    if (!['auto', 'direct', 'app'].includes(launch)) throw codeError('bad_args', 'launch: auto, direct oder app.');
    await ensureTools();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const busy = await settleStale();
    if (busy && ACTIVE.has(busy.status)) throw codeError('busy', `Es laeuft bereits eine Aufnahme (${busy.id}). Erst stoppen.`);
    const cleaned = await cleanup().catch(() => ({ removed: [] }));
    const free = await diskFree();
    const need = limits.minFreeBytes + seconds * 1.2 * MB;
    if (free < need) throw codeError('disk_full', `Zu wenig freier Speicher: ${(free / 1024 / MB).toFixed(1)} GB frei, noetig ${(need / 1024 / MB).toFixed(1)} GB (IPHONE_MIN_FREE_MB).`);
    const settle_wait_ms = await waitSettled();
    let retries = 0;
    const attempt = async mode => {
      for (;;) {
        try { return await startWith(seconds, mode, onEvent, capSeconds); } catch (e) {
          if (e.code !== 'no_device') throw e;
          if (retries >= NO_DEVICE_RETRIES) { e.message += NO_DEVICE_HINT; throw e; }
          retries++;
          onEvent?.({ event: 'retry', reason: 'no_device', attempt: retries });
          await sleep(500);
        }
      }
    };
    const done = r => ({ ...r, settle_wait_ms, no_device_retries: retries, cleaned: cleaned.removed });
    if (launch === 'auto') {
      try { return done(await attempt('direct')); } catch (e) {
        if (e.code !== 'camera_denied') throw e;
        if (!appConsent() || !existsSync(app)) throw e;
        return done(await attempt('app'));
      }
    }
    return done(await attempt(launch));
  }

  async function startWith(seconds, mode, onEvent, capSeconds = seconds) {
    const id = newId(), dir = dirOf(id);
    await mkdir(dir, { mode: 0o700 });
    const rec = { tool: MARKER, id, created: new Date().toISOString(), status: 'starting', requested_s: seconds, launch: mode, pid: null,
      request_t: nowMs(), started_t: null, stop_requested_t: null, stop_reason: null, error: null, actions: [], result: null };
    await saveRec(rec);
    try { await writeFile(currentPath, id, { flag: 'wx', mode: 0o600 }); } catch {
      await rm(dir, { recursive: true, force: true });
      throw codeError('busy', 'Eine andere Aufnahme startet gerade. Kurz warten und status pruefen.');
    }
    const evPath = join(dir, 'events.ndjson'), logPath = join(dir, 'helper.log'), mov = join(dir, 'screen.mov');
    const cap = String(Math.min(120, capSeconds));
    await writeFile(evPath, '', { mode: 0o600 });
    try {
      if (mode === 'direct') {
        const ev = openSync(evPath, 'a'), log = openSync(logPath, 'a');
        try {
          const child = spawn(helper, ['--no-stdin', mov, cap], { detached: true, stdio: ['ignore', ev, log] });
          child.on('error', () => {});
          child.unref();
          if (!child.pid) throw codeError('helper_failed', `USB-Helfer nicht startbar: ${helper}`);
          rec.pid = child.pid;
        } finally { closeSync(ev); closeSync(log); }
      } else {
        await mustRun('open', ['-n', '-g', '-a', app, '--stdout', evPath, '--stderr', logPath, '--args', '--no-stdin', mov, cap], { timeout: 15000 });
      }
      await saveRec(rec);
      let deadline = nowMs() + T.start, seen = 0;
      while (true) {
        const events = readEvents(evPath);
        for (const e of events.slice(seen)) {
          onEvent?.(e);
          if (e.event === 'launched' && e.pid) rec.pid ??= e.pid;
          if (e.event === 'access_pending') deadline = nowMs() + T.access;
        }
        seen = events.length;
        const err = events.find(e => e.event === 'error');
        if (err) throw codeError(err.code || 'capture_failed', err.message || 'USB-Aufnahme fehlgeschlagen.');
        const started = events.find(e => e.event === 'started');
        if (started) {
          rec.pid = started.pid ?? rec.pid;
          rec.started_t = started.t ?? nowMs();
          rec.status = 'recording';
          rec.start_latency_ms = Math.round(rec.started_t - rec.request_t);
          await saveRec(rec);
          return { id, dir, launch: mode, seconds, start_latency_ms: rec.start_latency_ms, pid: rec.pid };
        }
        if (rec.pid && !pidAlive(rec.pid) && !readEvents(evPath).some(e => e.event === 'started' || e.event === 'error')) {
          throw codeError('helper_died', `USB-Helfer ohne Startsignal beendet. Log: ${readFileSafe(logPath).slice(-300)}`);
        }
        if (nowMs() > deadline) {
          if (rec.pid) try { process.kill(rec.pid, 'SIGKILL'); } catch {}
          throw codeError('startup_timeout', 'USB-Aufnahme lieferte kein Startsignal. iPhone entsperren und Kabel pruefen.');
        }
        await sleep(T.poll);
      }
    } catch (e) {
      if (rec.pid && pidAlive(rec.pid)) try { process.kill(rec.pid, 'SIGKILL'); } catch {}
      if (rec.pid && !['no_device', 'camera_denied', 'multiple_devices'].includes(e.code)) await markHelperExit();
      await clearCurrent(id);
      await rm(dir, { recursive: true, force: true }); // own fresh folder without video
      throw e;
    }
  }

  function readFileSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

  // Stops the running (or given) recording; without a running recording: latest result (safe to repeat).
  async function stop({ id, analyze = true } = {}) {
    id ??= currentId();
    if (!id) {
      const last = (await listOwn())[0];
      if (!last) return { idle: true, note: 'Keine Aufnahme vorhanden.' };
      return { ...(await summary(last)), note: 'Keine laufende Aufnahme; letztes Ergebnis.' };
    }
    const rec = await loadRec(id);
    if (!ACTIVE.has(rec.status)) return summary(rec);
    const events = readEvents(join(dirOf(id), 'events.ndjson'));
    if (!events.some(e => e.event === 'finished' || e.event === 'error') && pidAlive(rec.pid)) {
      rec.stop_requested_t = nowMs(); rec.status = 'stopping';
      await saveRec(rec);
      try { process.kill(rec.pid, 'SIGTERM'); } catch {}
    }
    try { return await finalize(rec, { analyze }); } finally { await waitSettled(); }
  }

  // Waits for the helper to end (up to timeoutMs), converts and analyzes.
  async function finalize(rec, { analyze = true, timeoutMs = T.stop } = {}) {
    const dir = dirOf(rec.id), evPath = join(dir, 'events.ndjson'), mov = join(dir, 'screen.mov'), mp4 = join(dir, 'screen.mp4');
    const until = nowMs() + timeoutMs;
    let end;
    while (true) {
      const events = readEvents(evPath);
      end = events.find(e => e.event === 'finished') || events.find(e => e.event === 'error');
      if (end) break;
      if (!pidAlive(rec.pid)) { await sleep(100); end = readEvents(evPath).find(e => e.event === 'finished' || e.event === 'error'); break; }
      if (nowMs() > until) { try { process.kill(rec.pid, 'SIGKILL'); } catch {} break; }
      await sleep(T.poll);
    }
    await markHelperExit(end?.t ?? nowMs());
    rec.status = 'finishing';
    if (!end || end.event === 'error') {
      rec.status = 'error';
      rec.error = end ? { code: end.code, message: end.message } : { code: 'helper_lost', message: 'USB-Helfer ohne Abschlussmeldung beendet; Aufnahme unbrauchbar.' };
      rec.stop_reason = end?.code === 'device_error' ? 'device_error' : 'error';
      await saveRec(rec); await clearCurrent(rec.id);
      throw codeError(rec.error.code, rec.error.message, { id: rec.id });
    }
    rec.finished_t = end.t ?? nowMs();
    rec.stop_reason = rec.clip_stop ? 'time_limit' : end.reason || (rec.stop_requested_t ? 'manual' : 'time_limit');
    try {
      const [movInfo] = await Promise.all([
        run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mov], { timeout: 30000 }),
        mustRun('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ignore_editlist', '1', '-i', mov,
          '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', mp4], { timeout: 120000 }),
      ]);
      const v = await A.probeVideo(mp4);
      const t = A.timingStats(v.pts_ms);
      const editDur = Number(String(movInfo.stdout).trim());
      const preroll = Number.isFinite(editDur) && v.container_s ? Math.max(0, v.container_s - editDur) : null;
      await writeFile(join(dir, 'frames.json'), JSON.stringify({ first_pts_s: v.first_pts_s, pts_ms: v.pts_ms }), { mode: 0o600 });
      await unlink(mov).catch(() => {}); // keep only the MP4
      rec.result = {
        mp4, width: v.width, height: v.height, codec: v.codec, bytes: v.size,
        requested_s: rec.requested_s, recorded_s: rec.started_t ? Math.round(rec.finished_t - rec.started_t) / 1000 : null,
        video_s: Math.round(t.duration_ms) / 1000, preroll_s: preroll == null ? null : Math.round(preroll * 1000) / 1000,
        frames: t.frames, fps: t.fps, interval_ms: t.interval_ms, share_60hz_steps: t.share_60hz_steps, gaps_over_17_5ms: t.gaps_over_17_5ms,
        unique_frames: null, segments: null,
      };
      rec.status = 'complete';
      await saveRec(rec);
    } catch (e) {
      rec.status = 'error'; rec.error = { code: e.code || 'finalize_failed', message: e.message };
      await saveRec(rec); await clearCurrent(rec.id);
      throw e;
    }
    await clearCurrent(rec.id);
    if (analyze) await analysis(rec).catch(e => { rec.result.analysis_error = e.message; });
    await saveRec(rec);
    return summary(rec);
  }

  // Frame-change analysis (decode once, cache the result in the recording folder).
  async function analysis(rec, { minPx = A.DEFAULTS.minPx, quietMs = A.DEFAULTS.quietMs } = {}) {
    const dir = dirOf(rec.id), cache = join(dir, 'analysis.json');
    const frames = JSON.parse(await readFile(join(dir, 'frames.json'), 'utf8'));
    let diff;
    try {
      diff = JSON.parse(await readFile(cache, 'utf8'));
      if (diff.version !== 1 || diff.top_pt !== A.DEFAULTS.topPt) throw Error('veraltet');
    } catch {
      diff = await A.diffFrames(rec.result.mp4, { width: rec.result.width, height: rec.result.height });
      await writeFile(cache, JSON.stringify(diff), { mode: 0o600 });
    }
    const segments = A.motionSegments(frames.pts_ms, diff, { minPx, quietMs, width: rec.result.width });
    const unique = A.uniqueFrames(diff, minPx);
    if (minPx === A.DEFAULTS.minPx && quietMs === A.DEFAULTS.quietMs) {
      rec.result.unique_frames = unique;
      rec.result.segments = segments.map(({ n, start_ms, end_ms, dur_ms, frames: fr, fps, strength, box_pt }) => ({ n, start_ms, end_ms, dur_ms, frames: fr, fps, strength, box_pt }));
    }
    return { rec, frames, diff, segments, unique };
  }

  async function resolveId(id) {
    if (id && id !== 'last') { await loadRec(id); return id; }
    const cur = currentId();
    const own = await listOwn();
    const done = own.find(r => r.status === 'complete');
    if (!done) throw codeError('not_found', cur ? 'Aufnahme laeuft noch; erst stoppen.' : 'Noch keine fertige Aufnahme.');
    return done.id;
  }

  async function completeRec(id) {
    const rec = await loadRec(await resolveId(id));
    if (rec.status !== 'complete') throw codeError('not_ready', `Aufnahme ${rec.id} ist nicht fertig (${rec.status}).`);
    return rec;
  }

  async function changes({ id, minPx, quietMs, curve, region } = {}) {
    const rec = await completeRec(id);
    const before = JSON.stringify([rec.result.unique_frames, rec.result.segments]);
    const r = await analysis(rec, { minPx: minPx ?? A.DEFAULTS.minPx, quietMs: quietMs ?? A.DEFAULTS.quietMs });
    if (JSON.stringify([rec.result.unique_frames, rec.result.segments]) !== before) await saveRec(rec);
    const out = { id: rec.id, result: rec.result, segments: r.segments, unique: r.unique, pts_ms: r.frames.pts_ms, diff: r.diff };
    if (curve) {
      const seg = r.segments[curve - 1];
      if (!seg) throw codeError('bad_args', `Bewegung #${curve} gibt es nicht (${r.segments.length} gefunden).`);
      out.curve = { n: curve, ...(await A.progressCurve(rec.result.mp4, r.frames.pts_ms, seg, { width: rec.result.width, height: rec.result.height, top: r.diff.top, region })) };
    }
    return out;
  }

  async function frames({ id, times, maxDim = 600, format = 'jpg' } = {}) {
    if (!Array.isArray(times) || times.length < 1 || times.length > 8 || times.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0)) {
      throw codeError('bad_args', 'times: 1 bis 8 Zeitpunkte in Sekunden (>= 0).');
    }
    if (!Number.isInteger(maxDim) || maxDim < 64 || maxDim > 2622) throw codeError('bad_args', 'max_dim: 64 bis 2622.');
    const rec = await completeRec(id);
    const fr = JSON.parse(await readFile(join(dirOf(rec.id), 'frames.json'), 'utf8'));
    const outDir = join(dirOf(rec.id), 'views');
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const list = await A.extractFrames(rec.result.mp4, fr.pts_ms, times, { outDir, width: rec.result.width, height: rec.result.height, maxDim, format });
    return { id: rec.id, frames: list };
  }

  async function sheet({ id, from, to, cells = 12, cols = 6, width = 150, segment } = {}) {
    if (!Number.isInteger(cells) || cells < 2 || cells > 48) throw codeError('bad_args', 'cells: 2 bis 48.');
    if (!Number.isInteger(cols) || cols < 1 || cols > 12) throw codeError('bad_args', 'cols: 1 bis 12.');
    if (!Number.isInteger(width) || width < 60 || width > 400) throw codeError('bad_args', 'width: 60 bis 400.');
    const rec = await completeRec(id);
    const fr = JSON.parse(await readFile(join(dirOf(rec.id), 'frames.json'), 'utf8'));
    const pts = fr.pts_ms;
    let a, b, window;
    if (from != null || to != null) {
      a = A.frameIndexAt(pts, from ?? 0); if (a < 0) throw codeError('bad_args', 'from liegt hinter dem Ende.');
      b = to == null ? pts.length - 1 : Math.max(a, pts.findLastIndex(t => t <= to * 1000 + 0.5));
      window = 'Zeitfenster';
    } else {
      const { segments } = await analysis(rec);
      const seg = segments[(segment ?? 1) - 1];
      if (segment && !seg) throw codeError('bad_args', `Bewegung #${segment} gibt es nicht (${segments.length} gefunden).`);
      if (seg) { a = Math.max(0, seg.first - 1); b = Math.min(pts.length - 1, seg.last + 1); window = `Bewegung #${seg.n}`; } else { a = 0; b = pts.length - 1; window = 'ganzer Clip (keine Bewegung erkannt)'; }
    }
    const idx = A.pickEven(a, b, cells);
    const outDir = join(dirOf(rec.id), 'views');
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const outPath = join(outDir, `sheet-${Math.round(pts[a])}-${Math.round(pts[b])}-${idx.length}x${width}.png`);
    const s = await A.contactSheet(rec.result.mp4, pts, fr.first_pts_s, idx, { outPath, width: rec.result.width, height: rec.result.height, cellW: width, cols });
    return { id: rec.id, window, from_s: pts[a] / 1000, to_s: pts[b] / 1000, frames_in_window: b - a + 1, ...s };
  }

  async function summary(rec) {
    const pre = rec.result?.preroll_s;
    const actions = (rec.actions || []).map(a => ({ label: a.label, ms: Math.round(a.t1 - a.t0), ...(a.ok === false ? { ok: false, error: a.error } : {}),
      video_s: pre != null && rec.started_t ? Math.round((pre + (a.t0 - rec.started_t) / 1000) * 1000) / 1000 : null }));
    return { id: rec.id, status: rec.status, dir: dirOf(rec.id), launch: rec.launch, stop_reason: rec.stop_reason, error: rec.error,
      start_latency_ms: rec.start_latency_ms ?? null, created: rec.created, source: rec.source, ...rec.result, actions };
  }

  async function status() {
    const active = await settleStale();
    const own = await listOwn();
    const last = own.find(r => r.status === 'complete');
    let total = 0; for (const r of own) total += await dirSize(dirOf(r.id));
    const res = { root, active: null, last: last ? await summary(last) : null, count: own.length, bytes: total, free_bytes: await diskFree().catch(() => null),
      limits: { max_days: limits.maxDays, max_gb: limits.maxBytes / 1024 / MB }, app_consent: !!appConsent() };
    if (active && ACTIVE.has(active.status)) {
      res.active = { id: active.id, status: active.status, launch: active.launch, requested_s: active.requested_s,
        elapsed_s: active.started_t ? Math.round(nowMs() - active.started_t) / 1000 : null };
    }
    return res;
  }

  async function list({ limit = 10 } = {}) {
    const own = await listOwn();
    return Promise.all(own.slice(0, limit).map(async r => ({ id: r.id, status: r.status, created: r.created, stop_reason: r.stop_reason,
      video_s: r.result?.video_s ?? null, fps: r.result?.fps ?? null, unique_frames: r.result?.unique_frames ?? null,
      bytes: await dirSize(dirOf(r.id)), keep: existsSync(join(dirOf(r.id), '.keep')), error: r.error?.message ?? null })));
  }

  async function keep(id, on = true) {
    const rid = await resolveId(id);
    const p = join(dirOf(rid), '.keep');
    if (on) await writeFile(p, 'Nicht automatisch loeschen\n'); else await unlink(p).catch(() => {});
    return rid;
  }

  // Log an action during a recording (wall clock) to map it approximately to video time.
  async function markAction(label, t0, t1, extra = {}) {
    const id = currentId();
    if (!id) return null;
    const rec = await loadRec(id);
    if (!rec.started_t) return null;
    const entry = { label, t0, t1, ...extra };
    rec.actions.push(entry);
    await saveRec(rec);
    return entry;
  }

  // Fixed duration, blocking. Optional: action() runs `after` seconds after the start.
  async function clip({ seconds = 3, after = 0.5, action, analyze = true, onEvent } = {}) {
    if (typeof after !== 'number' || after < 0 || after >= seconds) throw codeError('bad_args', 'after: 0 bis unter seconds.');
    // The helper counts its maximum duration from the start of capture, i.e. including pre-roll before the start signal
    // (warm about 1 s, cold up to 3+ s); action and tail come on top. Hence a reserve; the stop comes from here.
    const s = await start({ seconds, onEvent, capSeconds: Math.min(120, seconds + CLIP_RESERVE_S) });
    let actionResult = null, actionError = null;
    try {
      let actionEnd = 0;
      if (action) {
        await sleep(after * 1000);
        const t0 = nowMs();
        try { actionResult = await action(); } catch (e) { actionError = e; }
        actionEnd = nowMs();
        // Store the outcome too: otherwise an action that ends after 0.1 s without a tap looks like a real tap.
        await markAction(typeof action.label === 'string' ? action.label : 'action', t0, actionEnd,
          { ok: !actionError, ...(actionError ? { error: String(actionError.message || actionError).slice(0, 300) } : {}) });
      }
      // End = `seconds` after the start signal, but never before action + tail (the action itself takes about 1 s).
      const rec = await loadRec(s.id);
      const stopAt = Math.max(rec.started_t + seconds * 1000, action ? actionEnd + CLIP_TAIL_MS : 0);
      const rest = stopAt - nowMs();
      if (rest > 0) await sleep(rest);
    } catch (e) {
      await stop({ id: s.id, analyze: false }).catch(() => {});
      throw e;
    }
    const rec = await loadRec(s.id);
    if (ACTIVE.has(rec.status) && pidAlive(rec.pid) && !readEvents(join(dirOf(s.id), 'events.ndjson')).some(e => e.event === 'finished' || e.event === 'error')) {
      rec.stop_requested_t = nowMs(); rec.clip_stop = true; rec.status = 'stopping';
      await saveRec(rec);
      try { process.kill(rec.pid, 'SIGTERM'); } catch {}
    }
    let res;
    try { res = await finalize(rec, { analyze, timeoutMs: 15000 }); } finally { await waitSettled(); }
    return { ...res, settle_wait_ms: s.settle_wait_ms, no_device_retries: s.no_device_retries, action_output: actionResult, action_error: actionError?.message ?? null };
  }

  // Import a video from elsewhere (MP4/MOV, e.g. QuickTime) as an own recording: changes/frames/sheet work afterwards.
  async function importVideo({ path, analyze = true } = {}) {
    if (!path || !existsSync(path)) throw codeError('not_found', `Datei nicht gefunden: ${path}`);
    await ensureTools();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const id = newId(), dir = dirOf(id), mp4 = join(dir, 'screen.mp4');
    await mkdir(dir, { mode: 0o700 });
    const rec = { tool: MARKER, id, created: new Date().toISOString(), status: 'finishing', requested_s: null, launch: 'import', source: resolve(path),
      pid: null, started_t: null, stop_reason: 'import', error: null, actions: [], result: null };
    await saveRec(rec);
    try {
      await mustRun('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ignore_editlist', '1', '-i', path,
        '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', mp4], { timeout: 120000 });
      const v = await A.probeVideo(mp4);
      const t = A.timingStats(v.pts_ms);
      await writeFile(join(dir, 'frames.json'), JSON.stringify({ first_pts_s: v.first_pts_s, pts_ms: v.pts_ms }), { mode: 0o600 });
      rec.result = { mp4, width: v.width, height: v.height, codec: v.codec, bytes: v.size, requested_s: null, recorded_s: null,
        video_s: Math.round(t.duration_ms) / 1000, preroll_s: null, frames: t.frames, fps: t.fps, interval_ms: t.interval_ms,
        share_60hz_steps: t.share_60hz_steps, gaps_over_17_5ms: t.gaps_over_17_5ms, unique_frames: null, segments: null };
      rec.status = 'complete';
      await saveRec(rec);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    if (analyze) await analysis(rec).catch(e => { rec.result.analysis_error = e.message; });
    await saveRec(rec);
    return summary(rec);
  }

  // One-time camera consent for the app wrapper (shows the macOS dialog; run only with the user present).
  async function setupApp({ timeoutMs = 120000, onEvent } = {}) {
    if (!existsSync(app)) throw codeError('missing_helper', `App-Huelle fehlt: ${app}. zsh build.sh ausfuehren.`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const tmp = join(root, `.setup-${process.pid}.ndjson`);
    await writeFile(tmp, '', { mode: 0o600 });
    try {
      await mustRun('open', ['-n', '-g', '-a', app, '--stdout', tmp, '--stderr', '/dev/null', '--args', '--access'], { timeout: 15000 });
      const until = nowMs() + timeoutMs; let seen = 0;
      while (nowMs() < until) {
        const ev = readEvents(tmp);
        for (const e of ev.slice(seen)) onEvent?.(e);
        seen = ev.length;
        const a = ev.find(e => e.event === 'access');
        if (a) {
          if (a.granted) await writeFile(appOkPath, JSON.stringify({ granted_at: new Date().toISOString(), app }), { mode: 0o600 });
          return { granted: !!a.granted, status: a.status };
        }
        await sleep(100);
      }
      throw codeError('access_timeout', 'Keine Antwort auf den Kamera-Dialog (2 min).');
    } finally { await unlink(tmp).catch(() => {}); }
  }

  return { root, helper, app, limits, start, stop, clip, finalize, importVideo, changes, frames, sheet, status, list, cleanup, keep, markAction, setupApp, currentId, listOwn, loadRec, diskFree, appConsent };
}
