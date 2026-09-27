# Notes for AI coding agents working on this repository

This file is for agents that change the code. Agents that only *use* the kit to operate an iPhone follow
`skill/iphone/SKILL.md` instead.

## Local, unversioned files

If they exist, these files are machine-specific and must never be committed: `skill/iphone/LOCAL.md`,
`.env.local`, `privat/`, `bench/`, `recordings/`, `backups/`, `iphone/helper/usb-screen`,
`iphone/helper/iPhone Capture.app/`, `iphone/helper/.app-access.json`. Read `skill/iphone/LOCAL.md` first when it
exists; it describes the local device and setup.

## Hard rules

1. **Do not touch `iphone/helper/usb-screen.swift`** unless a rebuild is intended. `iphone-capture doctor` and
   `iphone/build.sh --check` compare its modification time with the built binaries; any edit reports them as
   outdated. A rebuild changes the ad-hoc signature and invalidates the camera consent, which only the user can
   grant again (`iphone-capture setup-app`).
2. **Never run `iphone/build.sh` without `--check`, never run `iphone-capture setup-app`**, and never change
   camera or privacy settings.
3. **Stable interfaces:** CLI commands and flags, error codes, exit codes, `--json` keys, the recording marker
   `iphone-capture/1`, the 17 MCP tool names and parameters (each description ≤ 200 characters, `tools/list`
   under 12,000 characters, enforced by `test/mcp.test.mjs`), and the paths `skill/iphone/SKILL.md`,
   `iphone/bin/*` and `tools/*.sh`, which are referenced from outside the repository.
4. **No commands to a real device** (agent-device, `iphone-capture start|stop|clip|doctor`, `xcrun devicectl`)
   without the user's explicit go-ahead; only one agent drives the device at a time.

## Checks

```sh
(cd iphone && npm test)                   # offline: fake USB helper, fake agent-device, MCP protocol (needs ffmpeg)
zsh iphone/build.sh --check               # helper binaries up to date (never rebuild without the user)
for f in tools/*.sh iphone/build.sh; do zsh -n "$f"; done   # shell syntax
```

Images under `docs/images/` are committed; only add synthetic ones (e.g. from `iphone/examples/make-demo-clip.mjs`),
never real screen content.

Before publishing, scan the staged files for personal data (home paths, device or team IDs, e-mail addresses,
private app names or screen content). Commit messages and documentation are in English.
