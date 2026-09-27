#!/usr/bin/env node
// Test double for helper/usb-screen: same event protocol, creates a synthetic 60 fps MOV with ffmpeg.
// FAKE_MODE: ok (default) | denied | no_start | crash_after_start | error_after_start | pending_then_ok
// FAKE_NO_DEVICE=N + FAKE_COUNTER=file: the first N starts report no_device (like after the USB switch on a real iPhone).
// Animation: a black square moves 300 pt to the right from FAKE_ANIM_AT s (default 0.8) in 0.25 s with smoothstep (ease-in-out).
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
const mode = process.env.FAKE_MODE || 'ok';
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const now = () => performance.timeOrigin + performance.now();
let args = process.argv.slice(2);
emit({ event: 'launched', pid: process.pid, version: 'fake' });
if (args[0] === '--version') process.exit(0);
if (args[0] === '--access') { emit({ event: 'access', status: mode === 'denied' ? 'notDetermined' : 'authorized', granted: mode !== 'denied' }); process.exit(mode === 'denied' ? 3 : 0); }
args = args.filter(a => a !== '--no-stdin');
const [out, secondsArg] = args;
const seconds = Number(secondsArg);
const startDelay = Number(process.env.FAKE_START_MS || 120);
const animAt = Number(process.env.FAKE_ANIM_AT || 0.8);

function writeMovie(duration, reason) {
  const d = Math.max(0.5, duration);
  const x = `st(0,clip((t-${animAt})/0.25,0,1));20+300*ld(0)*ld(0)*(3-2*ld(0))`;
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=402x874:r=60:d=${d}`, '-f', 'lavfi', '-i', 'color=c=black:s=40x40:r=60',
    '-filter_complex', `[0][1]overlay=x='${x}':y=400:shortest=1:eval=frame`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '60', out]);
  emit({ event: 'finished', path: out, bytes: statSync(out).size, reason, t: now() });
  process.exit(0);
}

let noDevice = false;
if (process.env.FAKE_NO_DEVICE && process.env.FAKE_COUNTER) {
  let n = 0; try { n = Number(readFileSync(process.env.FAKE_COUNTER, 'utf8')) || 0; } catch {}
  writeFileSync(process.env.FAKE_COUNTER, String(n + 1));
  noDevice = n < Number(process.env.FAKE_NO_DEVICE);
  if (noDevice) {
    setTimeout(() => { emit({ event: 'access', status: 'authorized', granted: true }); emit({ event: 'error', code: 'no_device', message: 'Keine iOS-USB-Bildschirmquelle gefunden (Test).' }); process.exit(1); }, 150);
  }
}
if (mode === 'pending_then_ok') setTimeout(() => emit({ event: 'access_pending' }), 50);
if (!noDevice) setTimeout(() => {
  if (mode === 'denied') { emit({ event: 'access', status: 'notDetermined', granted: false }); emit({ event: 'error', code: 'camera_denied', message: 'Kein Kamerarecht (Test).' }); process.exit(1); }
  emit({ event: 'access', status: 'authorized', granted: true });
  if (mode === 'no_start') { setInterval(() => {}, 1000); return; }
  const t0 = now();
  emit({ event: 'started', pid: process.pid, t: t0 });
  if (mode === 'crash_after_start') setTimeout(() => process.exit(9), 200);
  if (mode === 'error_after_start') setTimeout(() => { emit({ event: 'error', code: 'device_error', message: 'USB getrennt (Test).' }); process.exit(1); }, 200);
  process.on('SIGTERM', () => writeMovie((now() - t0) / 1000, 'manual'));
  setTimeout(() => writeMovie(seconds, 'time_limit'), seconds * 1000);
}, mode === 'pending_then_ok' ? 700 : startDelay);
