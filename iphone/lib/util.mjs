// Small helpers without dependencies.
import { execFile } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_DIR = resolve(TOOL_DIR, '..');
export const DEFAULT_RECORDINGS = join(PROJECT_DIR, 'recordings');
export const HELPER_BIN = join(TOOL_DIR, 'helper', 'usb-screen');
export const HELPER_APP = join(TOOL_DIR, 'helper', 'iPhone Capture.app');

// Find Homebrew tools even when the caller (e.g. Claude Desktop) passes a short PATH.
export function ensurePath(env = process.env) {
  const parts = (env.PATH || '').split(':').filter(Boolean);
  for (const p of ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']) if (!parts.includes(p)) parts.unshift(p);
  env.PATH = parts.join(':');
  return env.PATH;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
// Wall clock in ms with sub-ms resolution; comparable across processes (unlike performance.now()).
export const nowMs = () => performance.timeOrigin + performance.now();

// execFile without throwing on exit != 0. Returns { code, stdout, stderr, ms }.
export function run(cmd, args, { timeout = 60000, encoding = 'utf8', maxBuffer = 64 << 20, env, cwd } = {}) {
  const t = nowMs();
  return new Promise(res => {
    execFile(cmd, args, { timeout, encoding, maxBuffer, env, cwd, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      let code = 0;
      if (error) code = typeof error.code === 'number' ? error.code : (error.killed ? 'timeout' : error.code || 1);
      res({ code, stdout, stderr: stderr?.toString?.() ?? '', ms: nowMs() - t, error: error && typeof error.code !== 'number' ? error : null });
    });
  });
}

export async function mustRun(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.error?.message || '').toString().trim().split('\n').slice(-3).join(' ');
    throw codeError('tool_failed', `${cmd} fehlgeschlagen (${r.code}): ${msg}`);
  }
  return r;
}

export function codeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

// Number with fixed decimals and a decimal point (values are often reused).
export const f = (n, d = 2) => (n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(d));
export const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
export const gb = bytes => `${(bytes / 1073741824).toFixed(1)} GB`;

export function pct(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const k = (s.length - 1) * q, lo = Math.floor(k), hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}

// Shell-like splitting: 'wait text "Hello World"' -> ['wait','text','Hello World'].
export function splitArgs(line) {
  const out = []; let cur = '', quote = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; }
    else { cur += c; has = true; }
  }
  if (quote) throw codeError('bad_args', `Anfuehrungszeichen nicht geschlossen: ${line}`);
  if (has || cur) out.push(cur);
  return out;
}

// Parallel map with a concurrency limit.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
