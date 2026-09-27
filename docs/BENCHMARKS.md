# Benchmarks

How the numbers in the README were measured, and how far they can be trusted. Raw data and screen recordings are not published because they contain private screen content.

## Setup and caveats

- **One device, one Mac:** iPhone 17 Pro (iOS 27.0) over USB, macOS 27.0, Xcode 27.0, agent-device 0.21.15. Measured in September 2026.
- **Small samples:** micro-benchmarks use n = 10 per command (cold starts n = 2–3), the end-to-end run is a single session, the recording comparison uses 3 runs per method.
- **Warm state:** unless stated otherwise, the agent-device daemon and runner were already running.
- **Tokens are estimates:** characters ÷ 4 for text, width × height ÷ 750 for images.
- **Wall-clock times** include starting the CLI process (about 0.1 s) but not the model's thinking time.
- Most measurements used one Flutter app with a tab bar, bottom sheets and long scrolling lists (which is why the skill has notes on Flutter sheets and back navigation). Only navigation, nothing was changed in the app.

## 1. Device control (agent-device CLI, warm, n = 10)

| Command | Median | p90 | Output |
|---|---|---|---|
| `snapshot -i` | 0.46 s | 0.89 s | ≈ 260 tokens |
| `snapshot -i --json` | 0.49 s | 0.52 s | ≈ 2,860 tokens |
| `wait text "…"` (text already visible) | 0.17 s | 0.21 s | 0 |
| `press @ref` | **1.02 s** | 1.28 s | ≈ 6 tokens |
| `press x y` | 1.10 s | 1.29 s | ≈ 4 tokens |
| `press <selector>` | 1.59 s | 2.04 s | ≈ 12 tokens |
| `press` + `wait text` (2 calls) | **1.79 s** | 2.21 s | ≈ 12 tokens |
| `press <selector> --settle` | 4.12 s | 4.28 s | ≈ 645 tokens |
| `press … --settle --settle-quiet 200` | 2.88 s | 2.95 s | ≈ 645 tokens |
| `scroll down` | 1.08 s | 1.53 s | ≈ 3 tokens |
| `scroll down --settle` | 5.61 s | 6.02 s | ≈ 236 tokens |
| `screenshot --scale 0.25` (302×656) | 0.51 s | 0.54 s | ≈ 264 image tokens |
| `open <app> --foreground` (returns a snapshot) | 0.76 s | 1.12 s | ≈ 283 tokens |
| `open --foreground`, runner cold | 7.1 s (n = 3) | – | – |
| First install / runner rebuild (e.g. after profile expiry) | ≈ 24 s (n = 1) | – | – |

Takeaways that shaped the skill: `press` without `--settle` followed by `wait text` is 2.3× faster than `--settle` (1.8 s vs 4.1 s) and returns about 12 instead of about 650 tokens. `--json` multiplies the output by about 11. About 1.1 s of every tap is spent inside the XCTest runner (≈ 0.75 s of accessibility pre-checks before the touch, ≈ 0.37 s after), so it is a property of the tooling, not of the app.

## 2. End-to-end agent session

A fresh Claude Code agent with only the skill as instructions ran a small scenario on the real device: navigate between three tabs, open and close a menu, record a tab switch, fetch frame times and three single frames, then hand the device over to a second headless agent. Tool times were measured around each shell command and exclude the model's thinking time; the whole scenario took about 2 min 35 s including the model.

| Criterion | Result |
|---|---|
| Median device-tool time per navigation step | **1.17 s** (5 steps: 0.88 / 0.95 / 1.17 / 1.68 / 2.28 s); 1.18 s over all 10 steps |
| Output per step | median 595 characters ≈ **150 tokens** (max 1,795 for a screen with 75 elements) |
| Tool calls per step | 1.4 (1.2 without two optional image reads) |
| Human help needed | none (0 questions, no unlock) |
| Recording of the tab switch | 60.0 fps during the motion, 10 frames in 150 ms, all frame-change times reported |
| Handover to a second agent | worked without `DEVICE_IN_USE` or session loss (17.8 s including model time) |

## 3. Recording animations: three methods compared

Same scripted scenario (two tab switches, a bottom sheet opened and closed, two scroll flings), triggered with agent-device while recording, 3 runs per method.

| | **USB helper (`iphone-capture`)** | `agent-device record --fps 60 --hide-touches` | `devicectl … screen-record` |
|---|---|---|---|
| Effective fps during motion | **56–60** | 8.6–10 (6.7 on average) | not supported on this device |
| Timestamps | real device timestamps, steps of 16.65–16.68 ms | 1/fps grid, time taken after the screenshot | – |
| Gaps > 17.5 ms | 1.2–2.0 % of intervals | 100 %; **0.7–1.25 s freeze on every tap** | – |
| Resolution | 1206×2622 native, no touch overlay | 1206×2622 | – |
| Start latency | request → start signal median 2.78 s (n = 5) | CLI ≈ 0.36 s | – |
| Can read animation durations | yes, to 16.7 ms | no (1–2 frames per UI animation) | – |

Motion durations read from the USB recordings (median of 3 runs):

| Motion | Duration | Changed frames | Effective fps |
|---|---|---|---|
| Tab switch | 150 ms | 9–10 | 56.5–60.0 |
| Bottom sheet opens | 242 ms | 15 | 57.9 |
| Bottom sheet closes | 183 ms | 12 | 57.4 |
| Scroll fling (coasting) | 2,959 ms | 177 | 59.5 |
| Scroll fling up incl. bounce | 1,384 ms | 80 | 58.6 |

The progress curve of the sheet opening was a clearly readable ease-in-out over 233 ms; agent-device's recording showed only a before and an after frame. That is expected: on real devices agent-device records by taking periodic XCTest screenshots, which suits overview videos rather than frame timing. Without `--hide-touches` it also draws touch circles into the video.

A later 4 s clip over the same USB path, analyzed with the finished CLI (`iphone-capture import`), measured **59.7 fps**, median frame interval **16.67 ms**, 242 frames, with a tab switch detected as 150 ms over 10 frames; clips recorded end-to-end with `iphone-capture clip` measured 58.0–58.2 fps overall.

## 4. Recording reliability

- **Series test:** 10 clips in a row (`clip 2 --after 0.5 -- press …`, alternating between two tabs) plus 2 cold starts after 60 s idle: **10/10 and 2/2**, no errors, no retries needed. The 150 ms tab animation was captured as 9–10 frames at 53–60 fps. This was checked in an independent second round with its own scripts and its own video analysis; an earlier round also passed 10/10 + 2/2 (two of its clips were disturbed by someone using the phone at the same time).
- **USB reconfiguration:** 0.71–0.89 s after a recording ends, the iPhone switches its USB configuration back. A recording started inside that window does not see the screen source for more than 20 s, and after such a failed start for 1–2 minutes. The recorder therefore waits 2 s after each helper exit (`IPHONE_CAPTURE_SETTLE_MS`). A counter-test without that wait failed 2 of 2 back-to-back clips; the additional retry with a fresh helper (up to twice on `no_device`) did not rescue them, so the settle time is what actually matters.
- **Timing of actions:** the time an action is logged at maps to video time within about ±0.1 s, in rare cases up to 0.9 s off. The exact start of an animation is taken from its first frame change instead.
- **Tap to first changed frame:** 0.65–1.44 s after `press` starts, which is practically the moment `press` returns.

## 5. MCP tool schema size

| Server | Tools | `tools/list` (compact JSON) | ≈ Tokens |
|---|---|---|---|
| `iphone-mcp` (this repository) | 17 | 7,589 characters (+ 726 characters of instructions) | **≈ 1.9k** (≈ 2.1k with instructions) |
| agent-device's own MCP server (0.21.15, all tools) | 59 | 236,013 characters | **≈ 59k** |

That is about 31× smaller, but the two servers cover different scopes: `iphone-mcp` only offers UI commands and recording, while agent-device's server exposes its full feature set; even a whitelist of 16 of its core tools would still be ≈ 14k tokens (it offers no tool filter). The first, German-language version of `iphone-mcp` measured 7,488 characters; `test/mcp.test.mjs` enforces a limit of 12,000. The schema is loaded into every chat that has the server enabled, which is why Claude Code and Codex use the CLI plus the skill (0 tokens until the skill is loaded) and only Claude Desktop, which has no shell, uses the MCP server.

## Known limits of the method

- 60 fps is the ceiling of the USB screen source. 120 Hz animations lose every second frame (visible as 8.33 ms steps in the gaps).
- The easing fit is an approximation: position-based for translations, image-difference-based for fades. Composite motions need `--region`.
- All numbers come from one device and mainly one app; other apps, devices or iOS versions may behave differently.
- Device control and recording were measured from Claude Code and Claude Desktop only; for Codex, only skill discovery was verified.
