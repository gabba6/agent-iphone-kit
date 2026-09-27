// MCP protocol and tools with a fake agent-device and the fake helper (no device needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startMcp, textOf, FAKE_AD, FAKE_HELPER } from './helpers.mjs';

let mcp, dir, adLog;
const env = {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iphone-mcp-test-'));
  adLog = join(dir, 'ad.ndjson');
  writeFileSync(join(dir, '.zshenv'), '# Test\nexport AGENT_DEVICE_IOS_TEAM_ID=TESTTEAM\nexport AGENT_DEVICE_IOS_BUNDLE_ID=de.test.runner\n');
  for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_DEVICE_')) env[k] = undefined;
  Object.assign(env, { HOME: dir, AGENT_DEVICE_BIN: FAKE_AD, FAKE_AD_LOG: adLog, IPHONE_CAPTURE_HELPER: FAKE_HELPER,
    IPHONE_CAPTURE_LAUNCH: 'direct', IPHONE_RECORDINGS_DIR: join(dir, 'rec'), PATH: '/usr/bin:/bin' });
  const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined));
  mcp = startMcp(clean, { inherit: false });
});
after(async () => { await mcp.close(); await rm(dir, { recursive: true, force: true }); });

const adCalls = () => { try { return readFileSync(adLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

test('initialize: Versionsauswahl, Faehigkeiten, Anleitung', async () => {
  const a = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(a.result.protocolVersion, '2025-06-18');
  assert.deepEqual(a.result.capabilities, { tools: { listChanged: false } });
  assert.equal(a.result.serverInfo.name, 'iphone');
  assert.match(a.result.instructions, /record_start/);
  const b = await mcp.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(b.result.protocolVersion, '2025-11-25');
  mcp.notify('notifications/initialized');
});

test('tools/list: 17 Werkzeuge, gueltige Schemas, < 12000 Zeichen', async () => {
  const r = await mcp.request('tools/list', {});
  const tools = r.result.tools;
  assert.equal(tools.length, 17);
  assert.equal(new Set(tools.map(t => t.name)).size, 17);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length <= 200, `${t.name}: Beschreibung zu lang`);
  }
  const size = JSON.stringify(r.result).length;
  console.log(`tools/list: ${tools.length} Werkzeuge, ${size} Zeichen, ca. ${Math.round(size / 4)} Tokens`);
  assert.ok(size < 12000, `tools/list ${size} Zeichen`);
});

test('Protokollfehler: -32601, -32700, -32600, -32602; Benachrichtigung ohne Antwort', async () => {
  const unk = await mcp.request('gibt/esnicht', {});
  assert.equal(unk.error.code, -32601);
  const tool = await mcp.request('tools/call', { name: 'gibtsnicht', arguments: {} });
  assert.equal(tool.error.code, -32602);
  const before = mcp.extra.length;
  mcp.raw('{kaputt');
  mcp.raw(JSON.stringify({ id: 77, method: 'ping' })); // ohne jsonrpc
  mcp.notify('notifications/cancelled', { requestId: 1 });
  const ping = await mcp.request('ping', {});
  assert.deepEqual(ping.result, {});
  await new Promise(r => setTimeout(r, 100));
  const extra = mcp.extra.slice(before);
  assert.ok(extra.some(m => m.error?.code === -32700 && m.id === null));
  assert.ok(extra.some(m => m.error?.code === -32600 && m.id === 77));
  assert.equal(extra.length, 2, 'Benachrichtigung darf keine Antwort erzeugen');
});

test('Eingabepruefung liefert Werkzeugfehler (isError)', async () => {
  let r = await mcp.call('press', {});
  assert.equal(r.isError, true); assert.match(textOf(r), /target oder x und y/);
  r = await mcp.call('press', { x: 1, y: 2, foo: 1 });
  assert.equal(r.isError, true); assert.match(textOf(r), /Unbekannter Parameter: foo/);
  r = await mcp.call('screenshot', { scale: 5 });
  assert.equal(r.isError, true); assert.match(textOf(r), /hoechstens 1/);
});

test('press ueber agent-device: Argumente, Umgebung aus ~/.zshenv, Fehlertext ohne Diagnosezeilen', async () => {
  let r = await mcp.call('press', { x: 121, y: 812 });
  assert.equal(r.isError, undefined);
  let last = adCalls().at(-1);
  assert.deepEqual(last.args, ['press', '121', '812']);
  assert.equal(last.team, 'TESTTEAM');
  r = await mcp.call('press', { target: '@e5', settle: true });
  assert.deepEqual(adCalls().at(-1).args, ['press', '@e5', '--settle', '--settle-quiet', '200']);
  r = await mcp.call('press', { target: '@e999' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Ref @e999 not found/);
  assert.doesNotMatch(textOf(r), /Diagnostic/);
});

test('screenshot kommt inline als PNG', async () => {
  const r = await mcp.call('screenshot', {});
  const img = r.content.find(c => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.equal(Buffer.from(img.data, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.match(textOf(r), /302x656 px/);
});

test('batch: Anfuehrungszeichen, Stopp beim Fehler, verbotene Befehle vorab abgelehnt', async () => {
  const n0 = adCalls().length;
  let r = await mcp.call('batch', { steps: ['press @e1', 'wait text "Hallo Welt"', 'press @e999', 'snapshot'] });
  assert.match(textOf(r), /3\. press @e999: FEHLER/);
  assert.match(textOf(r), /Abbruch nach Schritt 3 von 4/);
  const calls = adCalls().slice(n0).map(c => c.args);
  assert.deepEqual(calls[1], ['wait', 'text', 'Hallo Welt']);
  assert.equal(calls.length, 3);
  const n1 = adCalls().length;
  r = await mcp.call('batch', { steps: ['press @e1', 'install foo.ipa'] });
  assert.equal(r.isError, true); assert.match(textOf(r), /nicht erlaubt: install/);
  r = await mcp.call('batch', { steps: ['press @e1 --session andere'] });
  assert.equal(r.isError, true);
  assert.equal(adCalls().length, n1, 'nichts ausgefuehrt');
});

test('Aufnahme ueber MCP: clip mit Aktion, changes, frames, sheet, start/stop, status', async () => {
  let r = await mcp.call('record_clip', { seconds: 2, action: 'press 121 812', after: 0.3 });
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.match(t, /60\.0 fps gemessen/);
  assert.match(t, /Stopp: Zeitlimit/);
  assert.match(t, /Aktion "press 121 812"/);
  r = await mcp.call('record_changes', { curve: 1 });
  assert.match(textOf(r), /Kurve #1, Verfahren Position/);
  r = await mcp.call('record_frames', { times: [0.8, 0.95] });
  assert.equal(r.content.filter(c => c.type === 'image' && c.mimeType === 'image/jpeg').length, 2);
  r = await mcp.call('record_sheet', { cells: 6 });
  assert.equal(r.content.filter(c => c.type === 'image' && c.mimeType === 'image/png').length, 1);
  r = await mcp.call('record_start', { seconds: 5 });
  assert.match(textOf(r), /Aufnahme laeuft/);
  await mcp.call('press', { x: 40, y: 812 }); // Aktion waehrend der Aufnahme wird protokolliert
  r = await mcp.call('record_stop', {});
  assert.match(textOf(r), /Stopp: manuell/);
  assert.match(textOf(r), /Aktion "press 40 812"/);
  r = await mcp.call('record_status', { list: true });
  assert.match(textOf(r), /2 eigene Aufnahme/);
});
