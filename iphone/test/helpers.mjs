// Shared test helpers: temporary folders, fake helper, MCP client over stdio, local test settings.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = join(TEST_DIR, '..');
export const FAKE_HELPER = join(TEST_DIR, 'fake-usb-screen.mjs');
export const FAKE_AD = join(TEST_DIR, 'fake-agent-device.mjs');

export async function tempDir(t, prefix = 'iphone-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Startet bin/iphone-mcp und liefert request()/notify()/close().
export function startMcp(env, { inherit = true } = {}) {
  const child = spawn(process.execPath, [join(TOOL_DIR, 'bin', 'iphone-mcp')], { env: inherit ? { ...process.env, ...env } : env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); const extra = []; let buf = '', stderr = '', nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); } else extra.push(msg);
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
  return {
    child, extra, stderr: () => stderr,
    raw: line => child.stdin.write(line + '\n'),
    request(method, params, id = nextId++) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Zeitlimit fuer ${method}`)); }, 60000);
        pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) { send({ jsonrpc: '2.0', method, params }); },
    async call(name, args = {}) { return (await this.request('tools/call', { name, arguments: args })).result; },
    async close() { child.stdin.end(); await new Promise(r => child.once('exit', r)); },
  };
}

export const textOf = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

// Settings for the optional real-device tests: environment first, then KEY=value lines from <kit>/.env.local
// (not versioned, see env.example). Only IPHONE_* keys are read.
export function localSetting(name, file = join(TOOL_DIR, '..', '.env.local')) {
  if (process.env[name]) return process.env[name];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?(IPHONE_[A-Z0-9_]+)=(["']?)([^"'#]*?)\2\s*(#.*)?$/);
    if (m && m[1] === name) return m[3];
  }
  return undefined;
}
