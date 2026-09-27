// Thin wrapper around the agent-device CLI (session and device come from ~/.agent-device/config.json).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, ensurePath, splitArgs, codeError } from './util.mjs';

// Takes AGENT_DEVICE_* values from ~/.zshenv if the process did not inherit them (e.g. when started by Claude Desktop).
// The agent-device daemon keeps the environment of its first caller; without TEAM_ID it would sign incorrectly.
export function loadAgentDeviceEnv(env = process.env, file = join(homedir(), '.zshenv')) {
  const added = [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return added; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*export\s+(AGENT_DEVICE_[A-Z0-9_]+)=(["']?)([^"'\s#]*)\2\s*(#.*)?$/);
    if (m && env[m[1]] == null) { env[m[1]] = m[3]; added.push(m[1]); }
  }
  return added;
}

// Commands passed through to agent-device. Deliberately without install, settings, push, clipboard, close, daemon.
export const ALLOWED = new Set(['open', 'snapshot', 'press', 'longpress', 'swipe', 'scroll', 'back', 'fill', 'type', 'wait', 'is', 'get', 'find', 'screenshot', 'gesture', 'home', 'keyboard', 'appstate', 'apps', 'devices']);
const MUTATING = new Set(['open', 'press', 'longpress', 'swipe', 'scroll', 'back', 'fill', 'type', 'gesture', 'home', 'keyboard']);
const FORBIDDEN_FLAGS = /^--(session|device|udid|serial|platform|state-dir|daemon)/;

// Diagnostic lines only cost tokens; error text and hint are kept.
export function cleanOutput(text, max = 12000) {
  const lines = String(text || '').split('\n').filter(l => !/^(Diagnostic ID|Diagnostics Log):/.test(l));
  let out = lines.join('\n').trim();
  if (out.length > max) out = out.slice(0, max) + `\n... (${out.length - max} Zeichen gekuerzt)`;
  return out;
}

export function parseStep(step) {
  const args = Array.isArray(step) ? step.map(String) : splitArgs(String(step));
  if (args[0] === 'agent-device') args.shift();
  if (!args.length) throw codeError('bad_args', 'Leerer Schritt.');
  if (!ALLOWED.has(args[0])) throw codeError('bad_args', `Befehl nicht erlaubt: ${args[0]}. Erlaubt: ${[...ALLOWED].join(', ')}`);
  if (args.some(a => FORBIDDEN_FLAGS.test(a))) throw codeError('bad_args', 'Keine --session/--device/--platform-Flags: die Sitzung ist fest eingestellt.');
  return args;
}

export function createDevice({ bin = process.env.AGENT_DEVICE_BIN || 'agent-device', timeoutMs = 90000, onMutation } = {}) {
  ensurePath();
  loadAgentDeviceEnv();
  let queue = Promise.resolve();
  // One command after another (in call order); agent-device additionally serializes in its daemon.
  function exec(args, { timeout = timeoutMs } = {}) {
    const job = queue.then(async () => {
      const t0 = performance.timeOrigin + performance.now();
      const r = await run(bin, args, { timeout, env: process.env });
      const t1 = performance.timeOrigin + performance.now();
      if (MUTATING.has(args[0])) await onMutation?.(args.join(' '), t0, t1);
      const text = cleanOutput(`${r.stdout || ''}${r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''}`);
      if (r.code === 'timeout') return { ok: false, code: r.code, text: `Zeitlimit (${Math.round(timeout / 1000)} s) ueberschritten: agent-device ${args.join(' ')}`, ms: r.ms };
      if (r.error?.code === 'ENOENT') return { ok: false, code: 'ENOENT', text: `agent-device nicht gefunden (${bin}).`, ms: r.ms };
      return { ok: r.code === 0, code: r.code, text, ms: r.ms };
    });
    queue = job.catch(() => {});
    return job;
  }
  return { exec, run: step => exec(parseStep(step)) };
}
