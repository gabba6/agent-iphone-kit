// The synthetic demo clip from examples/make-demo-clip.mjs (used for the README's sample output): importing it and
// analyzing motion #1 must recover the easing and duration it was generated with. No device needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRecorder } from '../lib/recorder.mjs';
import { makeDemoClip, cubicBezier, DEMO } from '../examples/make-demo-clip.mjs';
import { tempDir, FAKE_HELPER } from './helpers.mjs';

test('cubicBezier: known values', () => {
  assert.equal(cubicBezier([0, 0, 1, 1], 0.3).toFixed(4), '0.3000');
  assert.equal(cubicBezier([0.42, 0, 0.58, 1], 0.5).toFixed(4), '0.5000');
  assert.ok(cubicBezier([0.42, 0, 1, 1], 0.5) < 0.35);
});

test('demo clip: two motions, motion #1 fitted as easeInOut over 350 ms', async t => {
  const dir = await tempDir(t);
  const clip = join(dir, 'demo.mp4');
  await makeDemoClip(clip);
  // The helper is not used by import; the fake only satisfies the "helper exists" check.
  const rec = createRecorder({ root: join(dir, 'recordings'), helper: FAKE_HELPER });
  const r = await rec.importVideo({ path: clip });
  assert.equal(r.frames, DEMO.fps * DEMO.seconds);
  assert.equal(r.fps, 60);
  const ch = await rec.changes({ curve: 1 });
  assert.equal(ch.segments.length, 2);
  assert.deepEqual(ch.segments.map(s => s.frames), [21, 15]);
  assert.equal(ch.curve.mode, 'Position');
  assert.ok(Math.abs(Math.abs(ch.curve.travel_pt) - 354) < 5, `travel ${ch.curve.travel_pt}`);
  const best = ch.curve.fit[0];
  assert.deepEqual(best.cp, DEMO.motions[0].cp);
  assert.ok(best.rmse < 0.01, `rmse ${best.rmse}`);
  assert.ok(Math.abs(best.dur_ms - DEMO.motions[0].dur_ms) <= 17, `dur ${best.dur_ms}`);
  assert.ok(ch.curve.overshoot <= 0.02);
});
