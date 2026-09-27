#!/usr/bin/env node
// Generates a synthetic screen recording for trying the analysis without a device:
// 1206x2622 px (iPhone 17 Pro, @3x), 60 fps, 3 s. A list screen stays still while a bottom sheet
//   - slides up  at 1.000 s over 350 ms with cubic-bezier(0.42, 0, 0.58, 1) (easeInOut), 354 pt of travel,
//   - slides down at 2.000 s over 250 ms with cubic-bezier(0.42, 0, 1, 1)    (easeIn).
// The easing is computed here independently of lib/analyze.mjs, so the analysis has to recover it from the pixels.
//
// Usage: node examples/make-demo-clip.mjs [out.mp4]
//        iphone-capture import out.mp4 && iphone-capture changes --curve 1
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO = {
  width: 1206, height: 2622, scale: 3, fps: 60, seconds: 3,
  sheetTopPt: 520, // top edge of the open sheet in points (the screen is 874 pt tall)
  motions: [
    { start_s: 1.0, dur_ms: 350, from: 0, to: 1, name: 'easeInOut', cp: [0.42, 0, 0.58, 1] },
    { start_s: 2.0, dur_ms: 250, from: 1, to: 0, name: 'easeIn', cp: [0.42, 0, 1, 1] },
  ],
};

// cubic-bezier(x1, y1, x2, y2) at x in 0..1: solve x(t) = x with Newton steps, bisection as a fallback.
export function cubicBezier([x1, y1, x2, y2], x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = t => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
  const by = t => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
  const dx = t => 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t ** 2 * (1 - x2);
  let t = x;
  for (let i = 0; i < 8; i++) {
    const d = dx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= (bx(t) - x) / d;
  }
  if (!(t >= 0 && t <= 1) || Math.abs(bx(t) - x) > 1e-7) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
  }
  return by(t);
}

// Sheet openness (0 = hidden, 1 = open) at time t in seconds.
export function sheetOpenness(t, motions = DEMO.motions) {
  let p = motions[0].from;
  for (const m of motions) {
    const x = (t - m.start_s) / (m.dur_ms / 1000);
    if (x <= 0) break;
    p = m.from + (m.to - m.from) * cubicBezier(m.cp, x);
  }
  return p;
}

function fillRect(buf, W, x0, y0, x1, y1, v) {
  for (let y = Math.max(0, y0); y < y1; y++) buf.fill(v, y * W + Math.max(0, x0), y * W + Math.min(W, x1));
}

function drawScreens({ width: W, height: H, scale: s, sheetTopPt }) {
  const pt = v => Math.round(v * s);
  // Static list screen: grouped background, large title, 5 rows with a text bar each. The sheet moves over the
  // empty lower half; a sheet sliding over other content is a composite motion and would need --region.
  const base = Buffer.alloc(W * H, 242);
  fillRect(base, W, pt(16), pt(100), pt(190), pt(130), 30);
  for (let i = 0; i < 5; i++) {
    const y = 160 + i * 64;
    fillRect(base, W, pt(16), pt(y), pt(386), pt(y + 52), 255);
    fillRect(base, W, pt(32), pt(y + 18), pt(32 + 90 + (i * 47) % 160), pt(y + 34), 110);
  }
  // Sheet (as tall as its open height): grabber, heading, three content rows and a dark button.
  const sheetH = H - pt(sheetTopPt);
  const sheet = Buffer.alloc(W * sheetH, 200);
  fillRect(sheet, W, pt(183), pt(6), pt(219), pt(11), 140);
  fillRect(sheet, W, pt(24), pt(30), pt(220), pt(52), 40);
  for (let i = 0; i < 3; i++) fillRect(sheet, W, pt(24), pt(76 + i * 64), pt(378), pt(120 + i * 64), 235);
  fillRect(sheet, W, pt(24), pt(280), pt(378), pt(326), 20);
  return { base, sheet, sheetH };
}

export async function makeDemoClip(out, opts = {}) {
  const cfg = { ...DEMO, ...opts };
  const { width: W, height: H, fps, seconds } = cfg;
  const { base, sheet, sheetH } = drawScreens(cfg);
  const frame = Buffer.alloc(W * H);
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
  { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', d => { stderr += d; });
  const done = new Promise((ok, fail) => {
    ff.on('error', fail);
    ff.on('close', code => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`))));
  });
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) {
    base.copy(frame);
    const top = H - Math.round(sheetOpenness(i / fps, cfg.motions) * sheetH);
    if (top < H) sheet.copy(frame, top * W, 0, (H - top) * W);
    if (!ff.stdin.write(Buffer.from(frame))) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  return { path: out, frames: n, ...cfg };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] || 'demo.mp4');
  makeDemoClip(out).then(r => {
    console.log(`${r.path}: ${r.width}x${r.height}, ${r.fps} fps, ${r.frames} frames`);
    for (const m of r.motions) console.log(`  ${m.to > m.from ? 'sheet opens ' : 'sheet closes'} at ${m.start_s.toFixed(3)} s, ${m.dur_ms} ms, ${m.name} cubic-bezier(${m.cp.join(', ')})`);
  }, e => { console.error(e.message); process.exitCode = 1; });
}
