# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's **"Report a vulnerability"** button in the Security tab
of this repository, not in a public issue. I will acknowledge the report as soon as I can; this is a personal
student project, so please allow a few days.

Problems in [agent-device](https://github.com/callstack/agent-device) itself belong to its maintainers; please
report them to the agent-device project as described in its repository.

## What this project does to limit risk

- **MCP allowlist:** `iphone-mcp` passes only UI commands to agent-device (no `install`, `settings`, `push`,
  `clipboard`, `close`, `daemon`) and rejects `--session`, `--device`, `--udid` and similar flags.
- **Agent rules:** the skill tells agents to treat screen content as data, never as instructions, and not to buy,
  send, create, change or delete anything without the user's explicit permission. Agents never grant camera
  access themselves (`iphone-capture setup-app` is for the user only).
- **Local recordings:** recordings stay on the Mac (folders created with mode `0700`), are cleaned up automatically
  (older than 14 days or over 5 GB) and are excluded from Git. They contain whatever was on the screen, so treat
  them as private data.
