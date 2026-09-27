// Unit tests for the analysis and helpers (synthetic data only, no device needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as A from '../lib/analyze.mjs';
import { splitArgs } from '../lib/util.mjs';
import { parseStep, loadAgentDeviceEnv, cleanOutput } from '../lib/device.mjs';
import { validate } from '../lib/mcp.mjs';
import { TOOLS } from '../lib/tools.mjs';
import { tempDir } from './helpers.mjs';

test('splitArgs: Anfuehrungszeichen und Escapes', () => {
  assert.deepEqual(splitArgs('wait text "Hallo Welt"'), ['wait', 'text', 'Hallo Welt']);
  assert.deepEqual(splitArgs(`press 'label="See All"' --settle`), ['press', 'label="See All"', '--settle']);
  assert.deepEqual(splitArgs('type ""'), ['type', '']);
  assert.throws(() => splitArgs('wait text "offen'));
});

test('parseStep: Whitelist und feste Sitzung', () => {
  assert.deepEqual(parseStep('agent-device press @e3'), ['press', '@e3']);
  assert.throws(() => parseStep('settings appearance dark'), /nicht erlaubt/);
  assert.throws(() => parseStep('close'), /nicht erlaubt/);
  assert.throws(() => parseStep('press @e1 --device other'), /--session/);
});

test('loadAgentDeviceEnv liest nur fehlende AGENT_DEVICE_*-Exporte', async t => {
  const dir = await tempDir(t);
  const file = join(dir, '.zshenv');
  writeFileSync(file, '# x\nexport AGENT_DEVICE_IOS_TEAM_ID=ABC123\nexport AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS="1800000"\nexport OTHER=1\nexport AGENT_DEVICE_IOS_BUNDLE_ID=keep\n');
  const env = { AGENT_DEVICE_IOS_BUNDLE_ID: 'schon-da' };
  assert.deepEqual(loadAgentDeviceEnv(env, file), ['AGENT_DEVICE_IOS_TEAM_ID', 'AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS']);
  assert.equal(env.AGENT_DEVICE_IOS_TEAM_ID, 'ABC123');
  assert.equal(env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS, '1800000');
  assert.equal(env.AGENT_DEVICE_IOS_BUNDLE_ID, 'schon-da');
  assert.equal(env.OTHER, undefined);
});

test('cleanOutput entfernt Diagnosezeilen', () => {
  assert.equal(cleanOutput('Error (X): a\nHint: b\nDiagnostic ID: 1\nDiagnostics Log: /x'), 'Error (X): a\nHint: b');
});

test('validate: Pflichtfelder, Typen, Grenzen, unbekannte Felder', () => {
  const press = TOOLS.find(t => t.name === 'press').inputSchema;
  assert.equal(validate(press, { x: 1, y: 2 }), null);
  assert.match(validate(press, { x: '1' }), /Zahl/);
  assert.match(validate(press, { q: 1 }), /Unbekannter/);
  const frames = TOOLS.find(t => t.name === 'record_frames').inputSchema;
  assert.match(validate(frames, {}), /times fehlt/);
  assert.match(validate(frames, { times: [] }), /mindestens 1/);
  assert.match(validate(frames, { times: [-1] }), /mindestens 0/);
});

test('bezier und fitCurve erkennen bekannte Kurven', () => {
  assert.equal(A.bezier([0, 0, 1, 1], 0.3).toFixed(3), '0.300');
  const cp = [0.215, 0.61, 0.355, 1];
  const pts = [[-16.7, 0]];
  for (let t = 0; t <= 300.1; t += 16.7) pts.push([t, A.bezier(cp, (t + 10) / 310)]);
  pts.push([300.6, 1]);
  const fit = A.fitCurve(pts);
  assert.match(fit[0].name, /easeOutCubic/);
});

test('bestShift findet Verschiebungen auch ohne Ueberlappung', () => {
  const a = new Float64Array(100).fill(200), b = new Float64Array(100).fill(200);
  for (let i = 5; i < 15; i++) a[i] = 0;
  for (let i = 80; i < 90; i++) b[i] = 0;
  assert.equal(Math.round(A.bestShift(a, b).d), 75);
});

test('timingStats und motionSegments an synthetischen Daten', () => {
  const pts = Array.from({ length: 121 }, (_, i) => i * 16.667);
  const st = A.timingStats(pts);
  assert.equal(st.fps, 60); assert.equal(st.gaps_over_17_5ms, 0);
  const changed = pts.map((_, i) => ((i >= 30 && i < 40) || (i >= 90 && i < 95) ? 50 : 0));
  const diff = { gw: 201, gh: 437, top: 20, changed, boxes: changed.map(c => (c ? [10, 30, 50, 60] : null)) };
  const segs = A.motionSegments(pts, diff, { width: 1206 });
  assert.equal(segs.length, 2);
  assert.equal(segs[0].frames, 10); assert.equal(Math.round(segs[0].dur_ms), 150);
  assert.deepEqual(segs[0].box_pt, [20, 60, 102, 122]);
  assert.equal(A.uniqueFrames(diff), 16);
});
