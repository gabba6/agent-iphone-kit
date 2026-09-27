// Compact text output (currently German) for CLI and MCP. Numbers use a decimal point so they can be reused directly.
import { f, mb, gb } from './util.mjs';

const REASON = {
  manual: 'manuell (stop)', time_limit: 'Zeitlimit', size_limit: 'Dateigroesse 256 MB erreicht',
  disk_full: 'Speicher voll', device_error: 'Geraet getrennt/Fehler', error: 'Fehler', import: 'uebernommen (import)',
};
export const reasonText = r => REASON[r] || r || '-';
const s3 = ms => f(ms / 1000, 3);

export function fmtStart(s) {
  const lines = [`Aufnahme laeuft: ${s.id} (max ${s.seconds} s, Start nach ${s.start_latency_ms} ms, Weg: ${s.launch === 'app' ? 'App-Huelle' : 'direkt'}).`,
    'Jetzt handeln, danach stop. Automatischer Stopp nach der Hoechstdauer.'];
  if (s.cleaned?.length) lines.push(`Aufgeraeumt: ${s.cleaned.length} alte Aufnahme(n).`);
  return lines.join('\n');
}

export function fmtSegments(segs, { max = 8 } = {}) {
  if (!segs?.length) return ['Keine Bewegung erkannt (Statusleiste ignoriert).'];
  const lines = segs.slice(0, max).map(s => {
    const box = s.box_pt ? ` | Bereich x${s.box_pt[0]}-${s.box_pt[2]} y${s.box_pt[1]}-${s.box_pt[3]} pt` : '';
    return `#${s.n} ${s3(s.start_ms)}-${s3(s.end_ms)} s | ${f(s.dur_ms, 0)} ms | ${s.frames} Bilder${s.fps ? ` | ${f(s.fps, 1)} fps` : ''} | Flaeche ${Math.round(s.strength * 100)} %${box}`;
  });
  if (segs.length > max) lines.push(`... ${segs.length - max} weitere (record_changes / changes)`);
  return lines;
}

export function fmtSummary(r) {
  if (r.idle) return r.note;
  const lines = [];
  if (r.note) lines.push(r.note);
  if (r.status !== 'complete') {
    lines.push(`Aufnahme ${r.id}: ${r.status}${r.error ? ` - ${r.error.message}` : ''}`);
    return lines.join('\n');
  }
  lines.push(r.launch === 'import' ? `Video ${r.id} uebernommen aus ${r.source}.` : `Aufnahme ${r.id} fertig. Stopp: ${reasonText(r.stop_reason)}.`);
  const pre = r.preroll_s != null ? `, davon ${f(r.preroll_s, 2)} s Vorlauf vor dem Startsignal` : '';
  const req = r.requested_s != null ? ` (angefordert ${r.requested_s} s, aufgenommen ${f(r.recorded_s, 2)} s${pre})` : '';
  lines.push(`Video ${f(r.video_s, 2)} s${req} | ${r.frames} Bilder | ${f(r.fps, 1)} fps gemessen` +
    `${r.unique_frames != null ? ` | ${r.unique_frames} einzigartig` : ''} | ${r.width}x${r.height} | ${mb(r.bytes)}`);
  if (r.interval_ms) lines.push(`Bildabstand Median ${f(r.interval_ms.median, 2)} ms, max ${f(r.interval_ms.max, 1)} ms; 60-Hz-Schritte ${Math.round(r.share_60hz_steps * 100)} %, Luecken >17.5 ms: ${r.gaps_over_17_5ms}.`);
  if (r.segments) { lines.push('Bewegungen (Zeiten ab 1. Videobild; Ruhe >= 300 ms trennt):'); lines.push(...fmtSegments(r.segments)); }
  else if (r.analysis_error) lines.push(`Analyse fehlgeschlagen: ${r.analysis_error}`);
  for (const a of r.actions || []) lines.push(`Aktion "${a.label}" (${a.ms} ms) bei ca. ${f(a.video_s, 2)} s Videozeit (Anker +-0.1 s, selten bis 0.9 s daneben; exakt ueber Bildwechsel).`);
  if (r.action_error) lines.push(`Aktion fehlgeschlagen: ${r.action_error}`);
  else if (r.action_output) lines.push(`Aktion: ${String(r.action_output).split('\n')[0].slice(0, 200)}`);
  lines.push(`MP4: ${r.mp4}`);
  return lines.join('\n');
}

export function fmtChanges(out, { detail } = {}) {
  const r = out.result;
  const lines = [`${out.id}: ${f(r.video_s, 2)} s, ${r.frames} Bilder, ${f(r.fps, 1)} fps, ${out.unique} einzigartig. Zeiten in s ab 1. Videobild; Statusleiste ignoriert.`];
  lines.push(...fmtSegments(out.segments, { max: 20 }));
  const pts = out.pts_ms;
  const minPx = 6;
  for (const s of out.segments.slice(0, 20)) {
    if (detail && detail !== s.n) continue;
    const t = [];
    for (let k = s.first; k <= s.last; k++) if (out.diff.changed[k] >= minPx) t.push(s3(pts[k]));
    const show = detail || t.length <= 24 ? t : [...t.slice(0, 12), '...', ...t.slice(-6)];
    lines.push(`#${s.n} Wechsel: ${show.join(' ')}${show.length < t.length ? ` (${t.length} gesamt, detail=${s.n} fuer alle)` : ''} | letztes Ruhebild ${s3(s.before_ms)}`);
  }
  if (out.curve) lines.push(...fmtCurve(out.curve));
  return lines.join('\n');
}

export function fmtCurve(c) {
  // Print at most 40 points (evenly spaced, first and last always included).
  const src = c.points.length <= 40 ? c.points : [...new Set(Array.from({ length: 40 }, (_, k) => Math.round(k * (c.points.length - 1) / 39)))].map(i => c.points[i]);
  const pts = src.map(([t, p]) => `${Math.round(t)}:${Math.round(p * 100)}`);
  const best = c.fit[0];
  const how = c.mode === 'Position' ? `Position (${c.axis}-Weg ${c.travel_pt} pt)` : 'Bilddifferenz (Ueberblendung/Farbe)';
  const lines = [`Kurve #${c.n}, Verfahren ${how}, Bereich ${c.region_pt.join(',')} pt. ms ab 1. Wechsel : % (0 = Ruhebild, 100 = Endbild)`, pts.join(' ')];
  if (best) {
    lines.push(`Passung: ${best.name} cubic-bezier(${best.cp.join(',')}) Abweichung ${f(best.rmse * 100, 1)} %, Dauer ca. ${f(best.dur_ms, 0)} ms (Start ${f(best.start_ms, 0)} ms)`);
    lines.push(`Alternativen: ${c.fit.slice(1, 4).map(x => `${x.name} ${f(x.rmse * 100, 1)} %`).join(', ')}`);
    if (best.rmse > 0.08) lines.push('Passung schwach: Bewegung zusammengesetzt? region auf ein Element begrenzen.');
  }
  lines.push(c.overshoot > 0.02 ? `Ueberschwingen ${Math.round(c.overshoot * 100)} %: vermutlich Feder (Spring).` : 'Kein Ueberschwingen.');
  return lines;
}

export function fmtFrames(out) {
  return [`${out.id}: ${out.frames.length} Bild(er), jeweils erstes Bild ab Zeitpunkt:`,
    ...out.frames.map(x => `${f(x.req_s, 3)} s -> Bild ${x.index} bei ${f(x.t_s, 3)} s (${x.w}x${x.h}) ${x.path}`)].join('\n');
}

export function fmtSheet(out) {
  return [`${out.id}: Kontaktbogen ${out.window}, ${f(out.from_s, 3)}-${f(out.to_s, 3)} s, ${out.cells.length} von ${out.frames_in_window} Bildern, ${out.w}x${out.h} px (ca. ${Math.round(out.w * out.h / 750)} Bild-Tokens).`,
    `Zeiten (s): ${out.cells.map(t => f(t, 3)).join(' ')}${out.labeled ? '' : ' (ohne Beschriftung: Schrift oder ffmpeg-Filter drawtext fehlt)'}`, out.path].join('\n');
}

export function fmtStatus(st, list) {
  const lines = [];
  if (st.active) lines.push(`Laeuft: ${st.active.id} (${st.active.status}, ${f(st.active.elapsed_s, 1)} von max ${st.active.requested_s} s, Weg ${st.active.launch}).`);
  else lines.push('Keine laufende Aufnahme.');
  if (st.last) lines.push(`Letzte: ${st.last.id} | ${f(st.last.video_s, 2)} s | ${f(st.last.fps, 1)} fps | ${st.last.unique_frames ?? '?'} einzigartig | Stopp: ${reasonText(st.last.stop_reason)}`);
  lines.push(`Ablage: ${st.root} | ${st.count} eigene Aufnahme(n), ${mb(st.bytes)} | frei ${st.free_bytes == null ? '?' : gb(st.free_bytes)} | Aufraeumen: > ${st.limits.max_days} Tage oder > ${st.limits.max_gb} GB`);
  if (list) {
    for (const r of list) lines.push(`${r.id} | ${r.status} | ${r.video_s == null ? '-' : f(r.video_s, 2) + ' s'} | ${r.fps == null ? '-' : f(r.fps, 1) + ' fps'} | ${r.unique_frames ?? '-'} einzigartig | ${mb(r.bytes)}${r.keep ? ' | behalten' : ''}${r.error ? ` | ${r.error.slice(0, 80)}` : ''}`);
  }
  return lines.join('\n');
}
