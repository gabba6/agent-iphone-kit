#!/bin/zsh
# Registers the lean MCP server "iphone" (iphone/bin/iphone-mcp) in the Claude Desktop configuration.
#
# Why a script: Claude Desktop keeps its configuration in memory and writes it back while running, so an entry added
# while the app is running can be overwritten again. Registering only sticks while Claude Desktop is QUIT.
#
# Run it in Terminal.app (not in a Claude chat: that chat ends when you quit Claude Desktop):
#   zsh tools/install-claude-desktop-mcp.sh
#       waits until Claude Desktop has quit (Cmd+Q), backs up the file to backups/config-desktop/,
#       adds the entry and starts Claude Desktop again
#   ... --check      check only: exit 0 = the entry points to this checkout, 1 = missing or outdated
#   ... --no-start   do not start Claude Desktop afterwards
# The agent-device signing values (AGENT_DEVICE_IOS_TEAM_ID, AGENT_DEVICE_IOS_BUNDLE_ID and the idle timeouts) are
# copied into the entry from the environment, or from "export" lines in ~/.zshenv (see env.example).
# Test without the real file: IPHONE_DESKTOP_CFG=<copy> IPHONE_DESKTOP_BACKUP=<dir> IPHONE_DESKTOP_PROC=<anything> ... --no-start
set -eu

CFG="${IPHONE_DESKTOP_CFG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
PROC="${IPHONE_DESKTOP_PROC:-/Applications/Claude.app/Contents/MacOS/Claude}"
ROOT="${0:A:h:h}"
SERVER="$ROOT/iphone/bin/iphone-mcp"
BACKUP_DIR="${IPHONE_DESKTOP_BACKUP:-$ROOT/backups/config-desktop}"
MODE=apply
START=1
for a in "$@"; do
  case $a in
    --check) MODE=check ;;
    --no-start|--kein-start) START=0 ;;
    *) echo "usage: zsh ${0:t} [--check] [--no-start]" >&2; exit 2 ;;
  esac
done

[[ -f "$CFG" ]] || { echo "ERROR: $CFG not found" >&2; exit 2; }
[[ -f "$SERVER" ]] || { echo "ERROR: $SERVER not found" >&2; exit 2; }
desktop_running() { ps -axo comm= | grep -Fqx -- "$PROC"; }

if [[ $MODE == apply ]]; then
  if [[ -z "${AGENT_DEVICE_IOS_TEAM_ID:-}" ]] && ! grep -Eq '^[[:space:]]*export[[:space:]]+AGENT_DEVICE_IOS_TEAM_ID=' "$HOME/.zshenv" 2>/dev/null; then
    echo "ERROR: AGENT_DEVICE_IOS_TEAM_ID is not set (environment or ~/.zshenv). See env.example." >&2
    exit 2
  fi
  if desktop_running; then
    if [[ -n "${CLAUDECODE:-}" ]]; then
      echo "Note: this call runs inside a Claude chat. Quitting Claude Desktop would end it too." >&2
      echo "Please run it in Terminal.app." >&2
      exit 1
    fi
    echo "Claude Desktop is still running. Quit it now with Cmd+Q; waiting (at most 10 min) ..."
    for i in {1..600}; do desktop_running || break; sleep 1; done
    desktop_running && { echo "Aborted: Claude Desktop is still running, nothing changed." >&2; exit 1; }
    sleep 2  # let the last write on quit finish
  fi
fi

/usr/bin/python3 - "$CFG" "$SERVER" "$MODE" "$BACKUP_DIR" <<'PY'
import json, os, re, shutil, sys, tempfile, time
cfg, server, mode, backup_dir = sys.argv[1:5]
KEYS = ["AGENT_DEVICE_IOS_TEAM_ID", "AGENT_DEVICE_IOS_BUNDLE_ID",
        "AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS", "AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS"]

def zshenv_values():
    # Same rule as loadAgentDeviceEnv() in iphone/lib/device.mjs: plain "export NAME=value" lines.
    out = {}
    try:
        text = open(os.path.expanduser("~/.zshenv"), encoding="utf-8").read()
    except OSError:
        return out
    for line in text.split("\n"):
        m = re.match(r"""^\s*export\s+(AGENT_DEVICE_[A-Z0-9_]+)=(["']?)([^"'\s#]*)\2\s*(#.*)?$""", line)
        if m:
            out[m.group(1)] = m.group(3)
    return out

fallback = zshenv_values()
env = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}
for key in KEYS:
    value = os.environ.get(key) or fallback.get(key)
    if value:
        env[key] = value
node = "/opt/homebrew/bin/node" if os.access("/opt/homebrew/bin/node", os.X_OK) else (shutil.which("node") or "node")
entry = {"command": node, "args": [server], "env": env}

d = json.load(open(cfg, encoding="utf-8"))
cur = (d.get("mcpServers") or {}).get("iphone")
if mode == "check":
    if cur is not None and cur.get("args") == [server]:
        print("ok: entry iphone points to " + server)
        sys.exit(0)
    print("MISSING/OUTDATED: iphone points to " + (json.dumps(cur.get("args")) if cur else "nothing (no entry)"))
    sys.exit(1)
if cur == entry:
    print("already registered, nothing to do")
    sys.exit(0)
os.makedirs(backup_dir, mode=0o700, exist_ok=True)
backup = os.path.join(backup_dir, time.strftime("claude_desktop_config.%Y%m%d-%H%M%S.json"))
shutil.copy2(cfg, backup)
d.setdefault("mcpServers", {})["iphone"] = entry
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cfg), prefix=".claude_desktop_config.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
os.chmod(tmp, 0o600)
os.replace(tmp, cfg)
json.load(open(cfg, encoding="utf-8"))
print("registered: iphone -> " + server)
print("backup of the previous file: " + backup)
PY

if [[ $MODE == apply && $START == 1 ]]; then
  open -a Claude
  echo "Claude Desktop is starting. Check again in a minute: zsh ${0:A} --check"
fi
