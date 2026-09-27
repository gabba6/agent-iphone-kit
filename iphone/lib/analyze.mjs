// Analysis of an MP4 with real timestamps: timestamps, frame changes, motion segments,
// progress curve, single frames and contact sheet. Only ffmpeg/ffprobe, no packages.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { run, mustRun, codeError, pct, mapLimit } from './util.mjs';

// Grayscale grid for comparison: 1/6 of the width (1206 -> 201), height to match. A pixel counts as changed at
// |delta| > 12, a frame as changed from 6 pixels on (calibrated on a static USB recording: 1 unique frame out of 263).
export const GRID_W = 201;
export const PIXEL_DELTA = 12;
export const DEFAULTS = { minPx: 6, quietMs: 300, topPt: 56 }; // 56 pt: status bar + expanded Dynamic Island
const FONT = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'].find(p => existsSync(p));

// Some ffmpeg builds (e.g. current Homebrew bottles) ship without the drawtext filter; then the sheet stays unlabeled.
let drawtextOk;
async function canDrawText() {
  if (process.env.IPHONE_CAPTURE_NO_DRAWTEXT === '1') return false;
  if (drawtextOk === undefined) {
    const r = await run('ffmpeg', ['-hide_banner', '-filters'], { timeout: 15000 }).catch(() => null);
    drawtextOk = !!r && /\sdrawtext\s/.test(String(r.stdout));
  }
  return drawtextOk;
}

// Scale px -> iOS points (@3x from 1080 px width, otherwise @2x).
export const pointScale = width => (width >= 1080 ? 3 : 2);

export async function probeVideo(mp4) {
  const { stdout } = await mustRun('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time:stream=width,height,codec_name:format=duration,size', '-of', 'json', mp4], { timeout: 60000 });
  const info = JSON.parse(stdout);
  const pts = (info.packets || []).map(p => Number(p.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!pts.length) throw codeError('no_frames', 'Video enthaelt keine lesbaren Bilder.');
  const s = info.streams?.[0] || {};
  const first = pts[0];
  return {
    width: Number(s.width), height: Number(s.height), codec: s.codec_name,
    size: Number(info.format?.size) || 0, container_s: Number(info.format?.duration) || null,
    first_pts_s: first, pts_ms: pts.map(p => Math.round((p - first) * 1e6) / 1e3),
  };
}

// Frame rate and intervals from the timestamps (ms from the first frame).
export function timingStats(ptsMs) {
  const n = ptsMs.length;
  const iv = ptsMs.slice(1).map((t, i) => t - ptsMs[i]);
  const span = n > 1 ? ptsMs[n - 1] - ptsMs[0] : 0;
  const med = pct(iv, 0.5);
  return {
    frames: n, span_ms: round(span, 1), duration_ms: round(span + (med || 0), 1),
    fps: n > 1 && span > 0 ? round((n - 1) / (span / 1000), 2) : null,
    interval_ms: iv.length ? { median: round(med, 3), p90: round(pct(iv, 0.9), 3), max: round(Math.max(...iv), 3) } : null,
    share_60hz_steps: iv.length ? round(iv.filter(v => v > 16.1 && v < 17.3).length / iv.length, 3) : null,
    gaps_over_17_5ms: iv.filter(v => v > 17.5).length,
  };
}

const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function gridSize(width, height) {
  const gw = Math.min(GRID_W, width);
  let gh = Math.max(2, Math.round(gw * height / width));
  if (gh % 2) gh += 1;
  return { gw, gh };
}

// Returns, for every frame, the number of pixels changed versus the previous frame and their bounding box.
export async function diffFrames(mp4, { width, height, topPt = DEFAULTS.topPt } = {}) {
  const { gw, gh } = gridSize(width, height);
  const top = Math.min(gh - 1, Math.round(topPt * pointScale(width) * gh / height));
  const FS = gw * gh;
  const changed = [0], boxes = [null];
  let prev = null, frames = 0, buf = Buffer.alloc(0), stderr = '';
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-skip_loop_filter', 'all', '-i', mp4, '-an', '-vf',
      `scale=${gw}:${gh}:flags=area,format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    p.stdout.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let off = 0;
      while (buf.length - off >= FS) {
        const fr = buf.subarray(off, off + FS); off += FS;
        if (prev) {
          let m = 0, x0 = gw, y0 = gh, x1 = -1, y1 = -1;
          for (let y = top; y < gh; y++) {
            const o = y * gw;
            for (let x = 0; x < gw; x++) {
              const d = fr[o + x] - prev[o + x];
              if (d > PIXEL_DELTA || d < -PIXEL_DELTA) {
                m++;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
              }
            }
          }
          changed.push(m); boxes.push(m ? [x0, y0, x1, y1] : null);
        }
        prev = Buffer.from(fr); frames++;
      }
      buf = buf.subarray(off);
    });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(codeError('decode_failed', `ffmpeg-Dekodierung fehlgeschlagen: ${stderr.trim()}`))));
  });
  return { version: 1, gw, gh, top, top_pt: topPt, pixel_delta: PIXEL_DELTA, frames, changed, boxes };
}

// Groups changed frames into motions; an idle gap >= quietMs separates them.
export function motionSegments(ptsMs, diff, { minPx = DEFAULTS.minPx, quietMs = DEFAULTS.quietMs, width } = {}) {
  const n = Math.min(ptsMs.length, diff.changed.length);
  const area = (diff.gh - diff.top) * diff.gw;
  const pxToPt = (width / diff.gw) / pointScale(width);
  const segs = []; let cur = null;
  for (let k = 1; k < n; k++) {
    if (diff.changed[k] < minPx) continue;
    if (cur && ptsMs[k] - ptsMs[cur.last] <= quietMs) {
      cur.last = k; cur.count++; cur.max = Math.max(cur.max, diff.changed[k]); grow(cur, diff.boxes[k]);
    } else {
      cur = { first: k, last: k, count: 1, max: diff.changed[k], box: diff.boxes[k] ? [...diff.boxes[k]] : null };
      segs.push(cur);
    }
  }
  return segs.map((s, i) => {
    const dur = ptsMs[s.last] - ptsMs[s.first];
    return {
      n: i + 1, first: s.first, last: s.last, before_ms: round(ptsMs[s.first - 1], 1),
      start_ms: round(ptsMs[s.first], 1), end_ms: round(ptsMs[s.last], 1), dur_ms: round(dur, 1), frames: s.count,
      fps: s.count > 1 && dur > 0 ? round((s.count - 1) / (dur / 1000), 1) : null,
      strength: round(s.max / area, 3),
      box_pt: s.box ? s.box.map((v, j) => Math.round(v * pxToPt + (j >= 2 ? pxToPt : 0))) : null,
    };
  });
}

function grow(seg, b) {
  if (!b) return;
  if (!seg.box) { seg.box = [...b]; return; }
  seg.box = [Math.min(seg.box[0], b[0]), Math.min(seg.box[1], b[1]), Math.max(seg.box[2], b[2]), Math.max(seg.box[3], b[3])];
}

export function uniqueFrames(diff, minPx = DEFAULTS.minPx) {
  return 1 + diff.changed.slice(1).filter(c => c >= minPx).length;
}

// ---------- Curve ----------
export const CURVES = [
  ['linear', [0, 0, 1, 1]],
  ['ease (CSS)', [0.25, 0.1, 0.25, 1]],
  ['easeIn', [0.42, 0, 1, 1]],
  ['easeOut', [0, 0, 0.58, 1]],
  ['easeInOut (iOS/Flutter/CSS)', [0.42, 0, 0.58, 1]],
  ['fastOutSlowIn (Flutter/Material)', [0.4, 0, 0.2, 1]],
  ['easeOutCubic (Flutter)', [0.215, 0.61, 0.355, 1]],
  ['easeInOutCubic (Flutter)', [0.645, 0.045, 0.355, 1]],
  ['easeOutQuad/decelerate', [0.25, 0.46, 0.45, 0.94]],
  ['M3 standard', [0.2, 0, 0, 1]],
  ['M3 emphasizedDecelerate', [0.05, 0.7, 0.1, 1]],
];

export function bezier([x1, y1, x2, y2], x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bx = t => ((1 - t) * (1 - t) * 3 * t * x1) + ((1 - t) * 3 * t * t * x2) + t * t * t;
  const by = t => ((1 - t) * (1 - t) * 3 * t * y1) + ((1 - t) * 3 * t * t * y2) + t * t * t;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 40; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
  return by(t);
}

// Best curve for points [t_ms, p] with p in 0..1. The true start lies between the last idle frame (points[0])
// and the first change (points[1]); it is estimated as well, in 16 steps.
export function fitCurve(points) {
  const tEnd = points[points.length - 1][0];
  const a = points[0][0], b = points.length > 2 ? points[1][0] : points[0][0];
  const results = [];
  for (const [name, cp] of CURVES) {
    let best = null;
    for (let s = 0; s <= 16; s++) {
      const t0 = a + (s / 16) * (b - a);
      const D = tEnd - t0;
      if (D <= 0) continue;
      let e = 0;
      for (const [t, p] of points) { const x = Math.max(0, (t - t0) / D); const d = bezier(cp, x) - p; e += d * d; }
      const rmse = Math.sqrt(e / points.length);
      if (!best || rmse < best.rmse) best = { name, cp, rmse, start_ms: t0, dur_ms: D };
    }
    if (best) results.push(best);
  }
  return results.sort((a, b) => a.rmse - b.rmse);
}

async function decodeRange(mp4, ptsMs, i0, count, width, height) {
  const { gw, gh } = gridSize(width, height);
  const FS = gw * gh;
  const ss = Math.max(0, ptsMs[i0] / 1000 - 0.0005).toFixed(6);
  const { stdout } = await mustRun('ffmpeg', ['-nostdin', '-v', 'error', '-ss', ss, '-i', mp4, '-an', '-frames:v', String(count),
    '-vf', `scale=${gw}:${gh}:flags=area,format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { encoding: 'buffer', timeout: 60000 });
  const frames = [];
  for (let k = 0; k + FS <= stdout.length; k += FS) frames.push(stdout.subarray(k, k + FS));
  return { frames, gw, gh };
}

// Mean per row (axis y) or column (axis x) inside the rectangle.
function profile(fr, gw, [x0, y0, x1, y1], axis) {
  const rows = y1 - y0 + 1, cols = x1 - x0 + 1;
  const p = new Float64Array(axis === 'y' ? rows : cols);
  for (let y = y0; y <= y1; y++) {
    const o = y * gw;
    for (let x = x0; x <= x1; x++) { const v = fr[o + x]; if (axis === 'y') p[y - y0] += v; else p[x - x0] += v; }
  }
  const div = axis === 'y' ? cols : rows;
  for (let i = 0; i < p.length; i++) p[i] /= div;
  return p;
}

// Shift d at which a[i] best matches b[i + d] (mean absolute deviation, parabolic refinement).
// Outside of b the edge value (background) applies, so even large jumps without overlap can be measured.
export function bestShift(a, b, maxShift = a.length - 1) {
  const n = a.length;
  const errAt = d => { let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[Math.min(n - 1, Math.max(0, i + d))]); return s / n; };
  const e0 = errAt(0);
  let best = 0, bestErr = e0;
  for (let r = 1; r <= maxShift; r++) {
    for (const d of [r, -r]) { const e = errAt(d); if (e < bestErr - 1e-9) { bestErr = e; best = d; } }
  }
  let frac = 0;
  if (best !== 0 || bestErr < e0) {
    const em = errAt(best - 1), ep = errAt(best + 1), den = em - 2 * bestErr + ep;
    if (den > 1e-9) frac = Math.max(-0.5, Math.min(0.5, (em - ep) / (2 * den)));
  }
  return { d: best + frac, err: bestErr, err0: e0 };
}

// Progress curve of a motion. Two methods:
//  Position: align each frame's row/column profile with the final frame; p = 1 - remaining distance / total distance.
//            For translations (sheets, slides, elements). Chosen when the alignment clearly reduces the error.
//  Image difference: p = 1 - |frame - final| / |idle - final|. For cross-fades and color changes.
// region: [x0, y0, x1, y1] in iOS points; default: the motion's bounding box.
export async function progressCurve(mp4, ptsMs, seg, { width, height, top, region }) {
  const i0 = Math.max(0, seg.first - 1), i1 = seg.last;
  const count = Math.min(i1 - i0 + 1, 600);
  const { frames, gw, gh } = await decodeRange(mp4, ptsMs, i0, count, width, height);
  if (frames.length < 2) throw codeError('curve_failed', 'Zu wenige Bilder fuer eine Kurve.');
  const k = gw / (width / pointScale(width));
  const reg = region || seg.box_pt;
  let [x0, y0, x1, y1] = reg ? reg.map(v => Math.round(v * k)) : [0, top, gw - 1, gh - 1];
  x0 = Math.max(0, Math.min(gw - 1, x0)); x1 = Math.max(x0, Math.min(gw - 1, x1));
  y0 = Math.max(region ? 0 : top, Math.min(gh - 1, y0)); y1 = Math.max(y0, Math.min(gh - 1, y1));
  const rect = [x0, y0, x1, y1];
  const last = frames[frames.length - 1];
  const t = i => round(ptsMs[i0 + i] - ptsMs[seg.first], 1);

  // Position: distance summed from frame-to-frame shifts (robust for long distances and scroll flings too).
  let mode = 'Bilddifferenz', axis = null, travelPt = null, pts;
  const cand = ['y', 'x'].map(ax => {
    const prof = frames.map(fr => profile(fr, gw, rect, ax));
    const maxShift = Math.min(prof[0].length - 1, 150);
    const pos = [0]; let err = 0, err0 = 0;
    for (let i = 1; i < prof.length; i++) {
      const s = bestShift(prof[i - 1], prof[i], maxShift);
      pos.push(pos[i - 1] + s.d); err += s.err; err0 += s.err0;
    }
    return { ax, pos, travel: pos[pos.length - 1], quality: err0 > 0 ? err / err0 : 1 };
  }).filter(c => Math.abs(c.travel) >= 1.5 && c.quality < 0.5).sort((x, y) => Math.abs(y.travel) - Math.abs(x.travel));
  if (cand.length) {
    const c = cand[0];
    pts = c.pos.map((v, i) => [t(i), round(v / c.travel, 4)]);
    mode = 'Position'; axis = c.ax; travelPt = round(c.travel / k, 1);
  } else {
    const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
    const mad = (a, b) => {
      let s = 0;
      for (let y = y0; y <= y1; y++) { const o = y * gw; for (let x = x0; x <= x1; x++) s += Math.abs(a[o + x] - b[o + x]); }
      return s / cnt;
    };
    const total = mad(frames[0], last);
    if (total < 0.05) throw codeError('curve_failed', 'Bewegung zu schwach fuer eine Kurve.');
    pts = frames.map((fr, i) => [t(i), round(1 - mad(fr, last) / total, 4)]);
  }
  const overshoot = Math.max(...pts.map(p => p[1])) - 1;
  const fit = fitCurve(pts);
  return { points: pts, fit, overshoot: round(overshoot, 3), mode, axis, travel_pt: travelPt,
    region_pt: [x0, y0, x1 + 1, y1 + 1].map(v => Math.round(v / k)) };
}

// ---------- Frames ----------
export function frameIndexAt(ptsMs, seconds) {
  const target = seconds * 1000 - 0.5;
  const i = ptsMs.findIndex(t => t >= target);
  return i;
}

export function scaledSize(width, height, maxDim) {
  const s = Math.min(1, maxDim / Math.max(width, height));
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  return { w: even(width * s), h: even(height * s) };
}

export async function extractFrames(mp4, ptsMs, times, { outDir, width, height, maxDim = 600, format = 'jpg' }) {
  const { w, h } = scaledSize(width, height, maxDim);
  const wanted = times.map(t => {
    const i = frameIndexAt(ptsMs, t);
    if (i < 0) throw codeError('bad_args', `Zeitpunkt ${t} s liegt hinter dem letzten Bild (${(ptsMs.at(-1) / 1000).toFixed(3)} s).`);
    return { req_s: t, index: i, t_s: round(ptsMs[i] / 1000, 4) };
  });
  return mapLimit(wanted, 4, async x => {
    const path = `${outDir}/f${String(Math.round(ptsMs[x.index])).padStart(6, '0')}ms-${w}.${format}`;
    if (!existsSync(path)) {
      const ss = Math.max(0, ptsMs[x.index] / 1000 - 0.0005).toFixed(6);
      await mustRun('ffmpeg', ['-nostdin', '-v', 'error', '-ss', ss, '-i', mp4, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area`,
        ...(format === 'jpg' ? ['-q:v', '3'] : []), '-y', path], { timeout: 30000 });
    }
    return { ...x, path, w, h };
  });
}

// Contact sheet: selected frames (ascending indices) labeled with their real time in ms. One ffmpeg call.
export async function contactSheet(mp4, ptsMs, firstPtsS, indices, { outPath, width, height, cellW = 150, cols = 6 }) {
  if (!indices.length) throw codeError('bad_args', 'Keine Bilder im Zeitfenster.');
  const i0 = indices[0];
  const rel = indices.map(i => i - i0);
  const rows = Math.ceil(indices.length / cols);
  const c = Math.min(cols, indices.length);
  const ss = Math.max(0, ptsMs[i0] / 1000 - 0.0005).toFixed(6);
  const sel = rel.map(k => `eq(n\\,${k})`).join('+');
  const label = FONT && await canDrawText()
    ? `,drawtext=fontfile=${FONT}:text='%{eif\\:round((t-${firstPtsS.toFixed(6)})*1000)\\:d} ms':x=4:y=4:fontsize=${Math.max(12, Math.round(cellW / 9))}:fontcolor=black:box=1:boxcolor=yellow@0.85:boxborderw=3`
    : '';
  await mustRun('ffmpeg', ['-nostdin', '-v', 'error', '-copyts', '-ss', ss, '-i', mp4, '-an',
    '-vf', `select='${sel}',scale=${cellW}:-2${label},tile=${c}x${rows}:padding=4:margin=4:color=white`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-y', outPath], { timeout: 60000 });
  const cellH = Math.round(cellW * height / width / 2) * 2;
  return { path: outPath, w: c * cellW + (c - 1) * 4 + 8, h: rows * cellH + (rows - 1) * 4 + 8, cells: indices.map(i => round(ptsMs[i] / 1000, 4)), labeled: !!label };
}

// Picks up to max frames evenly from [a, b] (indices), first and last always included.
export function pickEven(a, b, max) {
  const n = b - a + 1;
  if (n <= max) return Array.from({ length: n }, (_, k) => a + k);
  return [...new Set(Array.from({ length: max }, (_, k) => a + Math.round(k * (n - 1) / (max - 1))))];
}
