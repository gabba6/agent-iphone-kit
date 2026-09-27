# Changelog

## 1.0.0 – 2026-09-27

First public release.

- `iphone-capture`: USB screen recording of a real iPhone at up to 60 fps with device timestamps, motion
  segments, easing-curve fit, single frames, contact sheets, import of existing videos, automatic cleanup.
- `iphone-mcp`: lean MCP server (17 tools, about 2k tokens of schema) for Claude Desktop.
- Agent skill `iphone` for Claude Code and Codex with measured interaction patterns.
- `tools/install-claude-desktop-mcp.sh`: registers the MCP server in Claude Desktop.
- `iphone/examples/make-demo-clip.mjs`: synthetic screen recording with a known easing curve for trying the
  analysis without a device (also checked by the offline tests).
- Offline test suite with a fake USB helper and a fake agent-device; GitHub Actions CI on macOS.
