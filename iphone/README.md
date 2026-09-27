# iphone – recording, analysis and MCP server for a real iPhone

Tools that let AI agents operate a real iPhone and **capture animations precisely** (60 fps, real device timestamps). No npm dependencies. Device control goes through the [agent-device](https://github.com/callstack/agent-device) CLI (fixed session, e.g. `iphone`); recording goes through the own USB helper `usb-screen`.

| Part | For | File |
|---|---|---|
| `iphone-capture` (CLI) | Claude Code, Codex (via shell) | `bin/iphone-capture` |
| MCP server `iphone` (stdio) | Claude Desktop (no shell) | `bin/iphone-mcp` |
| Recorder and analysis | both | `lib/recorder.mjs`, `lib/analyze.mjs` |
| USB helper + app wrapper | both | `helper/usb-screen.swift`, `build.sh` |

## Setup

```sh
zsh build.sh            # builds helper/usb-screen and "helper/iPhone Capture.app" (ad-hoc signed)
zsh build.sh --check    # exit 0 = binaries are newer than the Swift source
iphone-capture doctor   # checks ffmpeg, helper, camera permission, storage, agent-device
```

The signing identifiers of the helper and the app wrapper can be set with `IPHONE_HELPER_ID` and `IPHONE_CAPTURE_BUNDLE_ID` (environment or `../.env.local`, see `../env.example`). Keep them stable once macOS has granted camera access.

### Claude Desktop

Register the server with `zsh ../tools/install-claude-desktop-mcp.sh` from Terminal.app while Claude Desktop is **quit**; a running Claude Desktop writes its in-memory configuration back and would overwrite the entry. The script backs up `~/Library/Application Support/Claude/claude_desktop_config.json` and writes an entry like this (`--check` verifies it):

```json
{ "command": "/opt/homebrew/bin/node",
  "args": ["/path/to/agent-iphone-kit/iphone/bin/iphone-mcp"],
  "env": { "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
           "AGENT_DEVICE_IOS_TEAM_ID": "<YOUR_TEAM_ID>", "AGENT_DEVICE_IOS_BUNDLE_ID": "com.example.agentdevice.runner",
           "AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS": "1800000", "AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS": "1800000" } }
```

The `AGENT_DEVICE_*` values are taken from the environment or from `export` lines in `~/.zshenv`. If they are missing at runtime, the server reads them from `~/.zshenv` as well; without the team ID the agent-device daemon would sign the runner incorrectly.

## Camera permission (important)

macOS treats the iPhone's screen source as a **camera**. Whether a recording may start depends on the program that launched the process:

- **Claude Desktop MCP:** works, because Claude Desktop starts the server as a separate `node` process, which can be granted access.
- **Claude Code shell directly:** does not work, because the host lacks the camera entitlement. A direct start reports `camera_denied` after about 0.2 s (measured). Codex is expected to behave the same; this is untested.
- **Solution for agent shells: the "iPhone Capture" app wrapper** (bundle ID from `IPHONE_CAPTURE_BUNDLE_ID`):
  1. The user sets it up **once, personally**, on the Mac: run `iphone-capture setup-app` and confirm the macOS dialog.
  2. After that, `iphone-capture` automatically falls back to the app wrapper on `camera_denied` (`--launch auto`). Measured from a Claude Code shell: 58–59 fps.
  3. Agents never run `setup-app` and never change camera or privacy permissions; if the permission is missing they only report it. `iphone-capture doctor` shows "App-Freigabe: erteilt" (app consent granted) once it is set up; the line saying the current process has no camera permission is normal inside Claude Code.
- After rebuilding the app (`build.sh`), macOS may ask again, because the ad-hoc signature changes.

## Recording and analyzing an animation

```sh
iphone-capture clip 3 --after 0.8 -- press 201 300   # record 3 s, tap after 0.8 s (an agent-device command)
iphone-capture changes                               # motions: start, end, duration, frame count, fps, area in pt
iphone-capture changes --curve 1                     # progress curve + best-fitting easing curve (cubic-bezier)
iphone-capture frames 1.884 1.95 2.034               # single frames (first frame at or after each time), 600 px
iphone-capture sheet --segment 1                     # contact sheet with real ms timestamps (about 820 image tokens)
```

Alternatively `start [SEC]` → actions → `agent-device wait 1000` → `stop` (without the wait the end of the last animation is missing; `SEC` includes about 1 s of pre-roll). Also: `status`, `list`, `import FILE` (QuickTime or other screen recordings), `keep ID`, `clean`, `--json`.

Without a device: `node examples/make-demo-clip.mjs demo.mp4` renders a synthetic clip with a known easing curve (a bottom sheet, `cubic-bezier(0.42, 0, 0.58, 1)` over 350 ms) that `import` and `changes --curve 1` can analyze. Use a temporary `IPHONE_RECORDINGS_DIR` to keep it apart from real recordings.
In the MCP server the tools are `record_start`, `record_stop`, `record_clip` (with `action`), `record_changes`, `record_frames` (images inline), `record_sheet` and `record_status`.

Rules:
- Times are seconds from the first video frame. The status bar and the Dynamic Island (top 56 pt) are ignored.
- The USB recording starts about 3 s after the request, so schedule the action with `--after` (CLI) or `after` (MCP).
- The zero point of an animation is its first frame change. The action time in the result is only a guide.
- Only pass single, downscaled images to the model: recordings contain private data.

## Device control in the MCP server

`open`, `snapshot`, `press`, `swipe`, `scroll`, `back`, `type`, `wait`, `batch`, `screenshot` (inline, default `scale 0.25`).
- Coordinates are iOS points (402×874 on an iPhone 17 Pro).
- Fastest loop: `snapshot` → `press @ref` → `wait text`.
- Use `settle` only when the next screen is unknown.
- `batch` only allows UI commands: no `install`, `settings`, `close`, `daemon` and no `--session` flags.

## Storage and cleanup

- **Location:** `$IPHONE_RECORDINGS_DIR`, default `../recordings`.
- **Per recording:** one folder with `screen.mp4`, `recording.json`, `frames.json`, `analysis.json` and the small helper logs `events.ndjson` and `helper.log`. The `.mov` is deleted after remuxing.
- **Before every start:**
  - Disk check: `IPHONE_MIN_FREE_MB` (default 1024) plus the estimated size must be free.
  - Cleanup: only own folders, recognized by `recording.json` with the marker. Deleted are recordings older than 14 days (`IPHONE_RECORDINGS_MAX_DAYS`), then the oldest until all together use at most 5 GB (`IPHONE_RECORDINGS_MAX_GB`).
  - Other folders and folders containing `.keep` are never touched.
  - USB settle time: about 0.9 s after each recording the iPhone switches its USB configuration back. `clip`/`stop` return only 2 s after the helper exited, and a new start waits the same way (`IPHONE_CAPTURE_SETTLE_MS`, default 2000). If the helper still reports `no_device`, the recorder starts a fresh helper up to 2 times. If a start does fall into the switch window (e.g. with a too small `IPHONE_CAPTURE_SETTLE_MS`), the source stays invisible for 1–2 min and every further attempt extends that; then wait instead of retrying.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `IPHONE_RECORDINGS_DIR` | `<kit>/recordings` | where recordings are stored |
| `IPHONE_CAPTURE_LAUNCH` | `auto` | `direct`, `app` or `auto` (direct, falls back to the app wrapper on `camera_denied`) |
| `IPHONE_CAPTURE_SETTLE_MS` | `2000` | wait after each recording (USB reconfiguration) |
| `IPHONE_MIN_FREE_MB` | `1024` | free space required in addition to the estimated size |
| `IPHONE_RECORDINGS_MAX_DAYS` / `_MAX_GB` | `14` / `5` | automatic cleanup limits |
| `IPHONE_CAPTURE_HELPER` | `helper/usb-screen` | alternative helper binary (used by the tests) |
| `AGENT_DEVICE_BIN` | `agent-device` | alternative agent-device binary (used by the tests) |

## Tests

```sh
npm test               # offline: fake helper, fake agent-device, MCP protocol, analysis, demo clip (needs ffmpeg)
npm run test:device    # real iPhone, only with IPHONE_REAL_DEVICE=1 (set by the script) and IPHONE_TEST_* configured
```

The device tests navigate between two screens of an app you choose (`IPHONE_TEST_APP`, `IPHONE_TEST_TAP_A/B`, `IPHONE_TEST_TEXT_A/B` in the environment or in `../.env.local`) and record one 3 s clip. They change nothing in the app.

## Limits

- **Frame rate:** USB delivers at most 60 fps. For 120 Hz animations every second frame is missing.
- **Curve:** an approximation. Translations are measured by position, cross-fades by image difference. For composite motions set `--region x0,y0,x1,y1` (pt).
- **Time mapping:** mapping actions to video time can be off by up to 0.9 s in rare cases; exact timing comes from frame changes.
- **Keyframes:** compression keyframes can appear as a one-frame motion with 0 % area (often at about 0.95 s); pick the real motion for `--curve`.
- **Springs:** the fit uses 11 cubic-bezier presets; spring parameters are not fitted, overshoot above 2 % is only flagged.
- **Messages:** CLI and MCP messages are currently German; codes, exit codes and `--json` keys are stable.
