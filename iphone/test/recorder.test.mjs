// Recorder core with the fake helper: start/stop, time limit, error paths, analysis, cleanup. No device needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createRecorder, MARKER } from '../lib/recorder.mjs';
import { sleep } from '../lib/util.mjs';
import { tempDir, FAKE_HELPER } from './helpers.mjs';

const make = (root, extra = {}) => createRecorder({ root, helper: FAKE_HELPER, launch: 'direct', settleMs: 0, ...extra });
const ids = root => readdirSync(root).filter(n => /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(n));

test('start/stop manuell: nur MP4, echte fps, Bewegung erkannt', async t => {
  const root = await tempDir(t);
  const rec = make(root);
  const s = await rec.start({ seconds: 5 });
  assert.equal(s.launch, 'direct');
  assert.ok(s.start_latency_ms < 5000);
  assert.equal(readFileSync(join(root, '.current'), 'utf8'), s.id);
  await sleep(1500);
  const r = await rec.stop();
  assert.equal(r.status, 'complete');
  assert.equal(r.stop_reason, 'manual');
  assert.equal(r.requested_s, 5);
  assert.ok(r.video_s > 1.2 && r.video_s < 2.5, `video_s ${r.video_s}`);
  assert.ok(Math.abs(r.fps - 60) < 0.5, `fps ${r.fps}`);
  assert.equal(r.unique_frames, 16); // 1 + 15 Bilder Bewegung (smoothstep ueber 0.25 s)
  assert.equal(r.segments.length, 1);
  assert.ok(Math.abs(r.segments[0].start_ms - 817) < 2 && Math.abs(r.segments[0].dur_ms - 233) < 2);
  const files = readdirSync(r.dir).sort();
  assert.ok(files.includes('screen.mp4'));
  assert.ok(!files.some(f => f.endsWith('.mov') || f.endsWith('.jpg')), files.join(','));
  assert.ok(!existsSync(join(root, '.current')));
  // wiederholbar: stop ohne laufende Aufnahme liefert das letzte Ergebnis
  const again = await rec.stop();
  assert.equal(again.id, s.id); assert.match(again.note, /Keine laufende Aufnahme/);
});

test('clip: feste Dauer, Zeitlimit als Stoppgrund, Aktion mit Videozeit', async t => {
  const root = await tempDir(t);
  const rec = make(root);
  const action = Object.assign(async () => 'getippt', { label: 'press 1 2' });
  const r = await rec.clip({ seconds: 2, after: 0.3, action });
  assert.equal(r.stop_reason, 'time_limit');
  assert.equal(r.requested_s, 2);
  assert.ok(Math.abs(r.video_s - 2) < 0.1, `video_s ${r.video_s}`);
  assert.equal(r.actions.length, 1);
  assert.ok(r.actions[0].video_s > 0.25 && r.actions[0].video_s < 0.7, `action ${r.actions[0].video_s}`);
  assert.equal(r.action_output, 'getippt');
});

// Regression 26.09.2026: Mit Vorlauf und ~1 s langer press-Aktion endete das Video, bevor die Animation kam.
test('clip: Aufnahme laeuft nach spaeter Aktion mindestens den Nachlauf weiter', async t => {
  const root = await tempDir(t);
  const rec = make(root);
  const action = Object.assign(async () => { await sleep(800); return 'getippt'; }, { label: 'press 1 2' });
  const r = await rec.clip({ seconds: 2, after: 1.5, action });
  assert.equal(r.stop_reason, 'time_limit');
  // Aktion endet bei ca. 2,3 s, Nachlauf 1,2 s -> Video mindestens ca. 3,4 s statt 2 s
  assert.ok(r.video_s >= 3.3, `video_s ${r.video_s}`);
  assert.ok(r.video_s < 4.5, `video_s ${r.video_s}`);
});

// F1 (26.09.2026): Nach dem Ende einer Aufnahme meldete der naechste Helfer no_device, weil das iPhone gerade die
// USB-Konfiguration zurueckschaltete. Jetzt: Beruhigungszeit nach dem Helfer-Ende und frischer Helfer bei no_device.
test('no_device: frischer Helfer bis zu zweimal, danach klarer Fehler ohne Reste', async t => {
  const root = await tempDir(t);
  const counter = join(root, '..', `${root.split('/').pop()}-zaehler`);
  t.after(() => { delete process.env.FAKE_NO_DEVICE; delete process.env.FAKE_COUNTER; });
  process.env.FAKE_COUNTER = counter;
  process.env.FAKE_NO_DEVICE = '2';
  const events = [];
  const rec = make(root);
  const s = await rec.start({ seconds: 3, onEvent: e => events.push(e.event) });
  assert.equal(s.no_device_retries, 2);
  assert.equal(events.filter(e => e === 'retry').length, 2);
  const r = await rec.stop({ analyze: false });
  assert.equal(r.status, 'complete');
  assert.equal(ids(root).length, 1); // fehlgeschlagene Versuche hinterlassen keine Ordner
  writeFileSync(counter, '0');
  process.env.FAKE_NO_DEVICE = '3';
  await assert.rejects(rec.start({ seconds: 3 }), e => e.code === 'no_device' && /1-2 min keine Aufnahme/.test(e.message));
  assert.equal(ids(root).length, 1);
  assert.ok(!existsSync(join(root, '.current')));
});

test('Beruhigungszeit: clip kehrt erst nach dem USB-Wechsel zurueck, naechster Start wartet sonst', async t => {
  const root = await tempDir(t);
  const rec = make(root, { settleMs: 700 });
  await rec.clip({ seconds: 1, after: 0.2, analyze: false });
  const exitT = Number(readFileSync(join(root, '.helper-exit'), 'utf8'));
  assert.ok(performance.timeOrigin + performance.now() >= exitT + 690, 'clip kehrte vor Ablauf der Beruhigungszeit zurueck');
  const s1 = await rec.start({ seconds: 2 });
  assert.equal(s1.settle_wait_ms, 0); // clip hat schon gewartet
  await rec.stop({ analyze: false });
  const exit2 = Math.round(performance.timeOrigin + performance.now());
  writeFileSync(join(root, '.helper-exit'), String(exit2));
  const s2 = await rec.start({ seconds: 2 });
  // The work before waiting (tool checks, cleanup) takes longer on a busy machine, so check the total delay.
  assert.ok(s2.settle_wait_ms > 0 && s2.settle_wait_ms <= 700, `settle_wait_ms ${s2.settle_wait_ms}`);
  assert.ok(performance.timeOrigin + performance.now() >= exit2 + 690, 'start did not wait for the settle time');
  await rec.stop({ analyze: false });
});

// F2 (26.09.2026): Eine Aktion, die nach ~0,1 s ohne Tipp endete, sah im Ergebnis wie ein echter Tipp aus.
test('clip: fehlgeschlagene Aktion wird mit Fehlertext in actions abgelegt', async t => {
  const root = await tempDir(t);
  const rec = make(root);
  const action = Object.assign(async () => { throw new Error('Error (COMMAND_FAILED): Runner did not accept connection'); }, { label: 'press 41 812' });
  const r = await rec.clip({ seconds: 1, after: 0.2, action, analyze: false });
  assert.match(r.action_error, /Runner did not accept/);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].ok, false);
  assert.match(r.actions[0].error, /COMMAND_FAILED/);
  const ok = await rec.clip({ seconds: 1, after: 0.2, action: Object.assign(async () => 'ok', { label: 'press 1 2' }), analyze: false });
  assert.equal(ok.actions[0].ok, undefined); // erfolgreiche Aktionen bleiben kompakt
});

test('kein Kamerarecht: schneller Fehler, kein Ordner, keine Sperre', async t => {
  const root = await tempDir(t);
  process.env.FAKE_MODE = 'denied';
  t.after(() => { delete process.env.FAKE_MODE; });
  // Isolated from the real app wrapper: otherwise, after a local consent (helper/.app-access.json), 'auto' falls
  // back to the real app and starts a real recording.
  const rec = make(root, { launch: 'auto', app: join(root, 'fehlt.app'), appOkPath: join(root, 'keine-freigabe.json') });
  const t0 = Date.now();
  await assert.rejects(rec.start({ seconds: 3 }), e => e.code === 'camera_denied');
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(ids(root), []);
  assert.ok(!existsSync(join(root, '.current')));
});

test('kein Startsignal: Zeitlimit, Helfer beendet, aufgeraeumt', async t => {
  const root = await tempDir(t);
  process.env.FAKE_MODE = 'no_start';
  t.after(() => { delete process.env.FAKE_MODE; });
  const rec = make(root, { timeouts: { start: 1200 } });
  await assert.rejects(rec.start({ seconds: 3 }), e => e.code === 'startup_timeout');
  assert.deepEqual(ids(root), []);
  assert.ok(!existsSync(join(root, '.current')));
});

test('Zugriffsdialog offen: Startfrist wird verlaengert', async t => {
  const root = await tempDir(t);
  process.env.FAKE_MODE = 'pending_then_ok';
  t.after(() => { delete process.env.FAKE_MODE; });
  const seen = [];
  const rec = make(root, { timeouts: { start: 400, access: 5000 } });
  const s = await rec.start({ seconds: 2, onEvent: e => seen.push(e.event) });
  assert.ok(seen.includes('access_pending'));
  const r = await rec.stop();
  assert.equal(r.id, s.id);
});

test('zweite Aufnahme waehrend einer laufenden wird abgelehnt', async t => {
  const root = await tempDir(t);
  const rec = make(root);
  const s = await rec.start({ seconds: 5 });
  await assert.rejects(rec.start({ seconds: 2 }), e => e.code === 'busy');
  const r = await rec.stop({ id: s.id, analyze: false });
  assert.equal(r.status, 'complete');
});

test('Helfer stirbt nach Start: Fehler helper_lost, Sperre frei', async t => {
  const root = await tempDir(t);
  process.env.FAKE_MODE = 'crash_after_start';
  t.after(() => { delete process.env.FAKE_MODE; });
  const rec = make(root);
  await rec.start({ seconds: 5 });
  await sleep(500);
  await assert.rejects(rec.stop(), e => e.code === 'helper_lost');
  assert.ok(!existsSync(join(root, '.current')));
  const st = await rec.status();
  assert.equal(st.active, null);
});

test('Geraetefehler nach Start wird gemeldet', async t => {
  const root = await tempDir(t);
  process.env.FAKE_MODE = 'error_after_start';
  t.after(() => { delete process.env.FAKE_MODE; });
  const rec = make(root);
  await rec.start({ seconds: 5 });
  await sleep(500);
  await assert.rejects(rec.stop(), e => e.code === 'device_error');
});

test('Zeitlimit ohne stop-Aufruf: naechster status stellt fertig', async t => {
  const root = await tempDir(t);
  const rec = make(root);
  const s = await rec.start({ seconds: 1 });
  await sleep(2200);
  const st = await rec.status();
  assert.equal(st.active, null);
  assert.equal(st.last.id, s.id);
  assert.equal(st.last.stop_reason, 'time_limit');
});

test('frames, sheet, changes mit Kurve', async t => {
  const root = await tempDir(t);
  const rec = make(root);
  await rec.clip({ seconds: 2 });
  const fr = await rec.frames({ times: [0, 0.8, 0.9, 1.0] , maxDim: 300 });
  assert.equal(fr.frames.length, 4);
  for (const x of fr.frames) { assert.ok(existsSync(x.path)); assert.ok(x.h <= 300); assert.ok(x.t_s >= x.req_s - 0.0006); }
  assert.equal(fr.frames[1].t_s, 0.8);
  await assert.rejects(rec.frames({ times: [99] }), e => e.code === 'bad_args');
  await assert.rejects(rec.frames({ times: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), e => e.code === 'bad_args');
  const sh = await rec.sheet({ cells: 8 });
  assert.ok(existsSync(sh.path)); assert.equal(sh.cells.length, 8); assert.equal(sh.window, 'Bewegung #1');
  const ch = await rec.changes({ curve: 1 });
  assert.equal(ch.segments.length, 1);
  assert.equal(ch.curve.mode, 'Position');
  assert.ok(Math.abs(ch.curve.travel_pt - 150) < 2, `travel ${ch.curve.travel_pt}`);
  assert.match(ch.curve.fit[0].name, /easeInOut/);
  assert.ok(Math.abs(ch.curve.fit[0].dur_ms - 250) < 20, `dur ${ch.curve.fit[0].dur_ms}`);
});

test('Speicherpruefung vor Start', async t => {
  const root = await tempDir(t);
  const rec = make(root, { minFreeMB: 1e9 });
  await assert.rejects(rec.start({ seconds: 2 }), e => e.code === 'disk_full');
  assert.deepEqual(ids(root), []);
});

test('Aufraeumen: nur eigene, alte oder zu grosse Aufnahmen; .keep und fremde bleiben', async t => {
  const root = await tempDir(t);
  const mk = (id, daysAgo, { own = true, keep = false, bytes = 1000 } = {}) => {
    mkdirSync(join(root, id));
    const rec = { tool: own ? MARKER : 'fremd', id, created: new Date(Date.now() - daysAgo * 86400000).toISOString(), status: 'complete' };
    writeFileSync(join(root, id, 'recording.json'), JSON.stringify(rec));
    writeFileSync(join(root, id, 'screen.mp4'), Buffer.alloc(bytes));
    if (keep) writeFileSync(join(root, id, '.keep'), '');
  };
  mk('20260901-100000-aaaa', 20);                 // alt -> weg
  mk('20260902-100000-bbbb', 20, { keep: true }); // alt, aber behalten
  mk('20260903-100000-cccc', 20, { own: false }); // fremd -> bleibt
  mk('20260920-100000-dddd', 2, { bytes: 4000 });  // jung, aelter von beiden
  mk('20260925-100000-eeee', 1, { bytes: 4000 });  // jung, neuester
  mkdirSync(join(root, '2026-09-26T15-23-00-252Z-916ef62a'));  // Ordner des alten MCP -> nie anfassen
  const rec = make(root, { maxDays: 14, maxGB: 6000 / 1024 ** 3 });
  const dry = await rec.cleanup({ dryRun: true });
  assert.deepEqual(dry.removed.map(r => r.id).sort(), ['20260901-100000-aaaa', '20260920-100000-dddd']);
  assert.equal(ids(root).length, 5);
  const real = await rec.cleanup();
  assert.equal(real.removed.length, 2);
  assert.deepEqual(ids(root).sort(), ['20260902-100000-bbbb', '20260903-100000-cccc', '20260925-100000-eeee']);
  assert.ok(existsSync(join(root, '2026-09-26T15-23-00-252Z-916ef62a')));
});

test('App-Huelle: Start ueber open, Ereignisse ueber Datei, Stopp per Signal', async t => {
  const root = await tempDir(t);
  const app = join(root, 'Fake Capture.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.example.iphone-capture.test</string><key>CFBundleExecutable</key><string>run</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
  const exe = join(app, 'Contents', 'MacOS', 'run');
  writeFileSync(exe, `#!/bin/sh\nexport PATH="${process.env.PATH}"\nexec "${process.execPath}" "${FAKE_HELPER}" "$@"\n`);
  chmodSync(exe, 0o755);
  const rec = createRecorder({ root, helper: FAKE_HELPER, app, launch: 'app' });
  const s = await rec.start({ seconds: 5 });
  assert.equal(s.launch, 'app');
  assert.ok(s.pid > 0);
  await sleep(1200);
  const r = await rec.stop();
  assert.equal(r.status, 'complete');
  assert.equal(r.stop_reason, 'manual');
  assert.ok(r.fps > 59);
});
