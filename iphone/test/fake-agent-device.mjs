#!/usr/bin/env node
// Test double for the agent-device CLI: logs calls, returns small answers, creates a PNG for screenshot.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (process.env.FAKE_AD_LOG) appendFileSync(process.env.FAKE_AD_LOG, JSON.stringify({ args, team: process.env.AGENT_DEVICE_IOS_TEAM_ID ?? null }) + '\n');
const [cmd] = args;
if (cmd === 'screenshot') {
  const path = args[1]; const scale = Number(args[args.indexOf('--scale') + 1] || 1);
  const w = Math.round(1206 * scale), h = Math.round(2622 * scale);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=${w}x${h}`, '-frames:v', '1', '-y', path]);
  console.log(`${path} (${w}x${h})`); process.exit(0);
}
if (cmd === 'press' && args[1] === '@e999') {
  console.error('Error (COMMAND_FAILED): Ref @e999 not found\nHint: Snapshot refs expire when the UI changes.\nDiagnostic ID: x\nDiagnostics Log: /tmp/x.ndjson');
  process.exit(1);
}
if (cmd === 'snapshot') { console.log('Page: com.example\n@e1 [button] "OK"'); process.exit(0); }
if (cmd === 'sleep') { setTimeout(() => process.exit(0), Number(args[1])); }
else console.log(`fake ${args.join(' ')}`);
