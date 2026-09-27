// Short tests on a real iPhone (only with IPHONE_REAL_DEVICE=1). They only navigate between two screens of an app
// you choose and change nothing. Configure them in the environment or in <kit>/.env.local (see env.example):
//   IPHONE_TEST_APP     bundle ID that must be in the foreground, e.g. com.apple.Preferences
//   IPHONE_TEST_TAP_A   "x,y" in points, a tap that opens screen A (e.g. a tab); IPHONE_TEST_TEXT_A is visible there
//   IPHONE_TEST_TAP_B   "x,y" in points, a tap that returns to screen B;         IPHONE_TEST_TEXT_B is visible there
//   IPHONE_REAL_DEVICE=1 node --test --test-concurrency=1 test/device.test.mjs   (or: npm run test:device)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp, textOf, tempDir, localSetting } from './helpers.mjs';
import { createRecorder } from '../lib/recorder.mjs';
import { createDevice } from '../lib/device.mjs';
import { f } from '../lib/util.mjs';

const REAL = process.env.IPHONE_REAL_DEVICE === '1';
const point = v => {
  const [x, y] = String(v ?? '').split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};
const APP = localSetting('IPHONE_TEST_APP');
const TAP_A = point(localSetting('IPHONE_TEST_TAP_A')), TEXT_A = localSetting('IPHONE_TEST_TEXT_A');
const TAP_B = point(localSetting('IPHONE_TEST_TAP_B')), TEXT_B = localSetting('IPHONE_TEST_TEXT_B');
const configured = APP && TAP_A && TAP_B && TEXT_A && TEXT_B;
const skip = !REAL ? 'only with IPHONE_REAL_DEVICE=1 (real iPhone, test app in the foreground)'
  : !configured ? 'set IPHONE_TEST_APP, IPHONE_TEST_TAP_A/B and IPHONE_TEST_TEXT_A/B (environment or .env.local)' : false;

test('MCP on a real device: snapshot, inline screenshot, press + wait', { skip }, async t => {
  const root = await tempDir(t);
  const mcp = startMcp({ IPHONE_RECORDINGS_DIR: root });
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const ms = {};
  const timed = async (name, args) => { const t0 = performance.now(); const r = await mcp.call(name, args); ms[name + (args.x ? `@${args.x}` : '')] = Math.round(performance.now() - t0); return r; };
  const snap = await timed('snapshot', {});
  assert.equal(snap.isError, undefined, textOf(snap));
  assert.ok(textOf(snap).includes(APP), `${APP} must be in the foreground`);
  const shot = await timed('screenshot', {});
  const img = shot.content.find(c => c.type === 'image');
  assert.ok(img && Buffer.from(img.data, 'base64').length > 1000);
  assert.match(textOf(shot), /\d+x\d+ px/);
  let r = await timed('press', TAP_A);
  assert.equal(r.isError, undefined, textOf(r));
  r = await timed('wait', { text: TEXT_A, timeout_ms: 4000 });
  assert.equal(r.isError, undefined, textOf(r));
  r = await timed('press', TAP_B);
  assert.equal(r.isError, undefined, textOf(r));
  r = await timed('wait', { text: TEXT_B, timeout_ms: 4000 });
  assert.equal(r.isError, undefined, textOf(r));
  console.log('MCP real device, ms:', JSON.stringify(ms), `| screenshot ${Buffer.from(img.data, 'base64').length} bytes`);
});

test('3 s clip on a real device (USB helper) with a transition', { skip }, async t => {
  const root = await tempDir(t);
  const rec = createRecorder({ root, launch: process.env.IPHONE_CAPTURE_LAUNCH || 'auto' });
  const device = createDevice();
  const press = p => Object.assign(async () => { const r = await device.exec(['press', String(p.x), String(p.y)]); if (!r.ok) throw new Error(r.text); return r.text; }, { label: `press ${p.x} ${p.y}` });
  const t0 = performance.now();
  let res;
  try {
    res = await rec.clip({ seconds: 3, after: 0.8, action: press(TAP_A) });
  } catch (e) {
    if (e.code === 'camera_denied') {
      console.log(`No camera permission in this process (${Math.round(performance.now() - t0)} ms until the error): ${e.message}`);
      t.skip('no camera permission (TCC) - recording only via the Claude Desktop MCP or the app wrapper');
      return;
    }
    throw e;
  } finally {
    await device.exec(['press', String(TAP_B.x), String(TAP_B.y)]);
  }
  console.log(`Clip: ${f(res.video_s, 2)} s, ${res.frames} frames, ${f(res.fps, 1)} fps, ${res.unique_frames} unique, start ${res.start_latency_ms} ms, stop ${res.stop_reason}, motions: ${JSON.stringify(res.segments)}`);
  assert.ok(res.fps > 50, `fps ${res.fps}`);
  assert.equal(res.stop_reason, 'time_limit');
  assert.ok(res.segments.length >= 1, 'the transition must show up as a motion');
});
