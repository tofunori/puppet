#!/usr/bin/env bash
# Installs the puppet wrapper and registers it as a user-scoped Claude Code MCP server.
#
#   ./install.sh                 install, register, add the puppet skill, and add the computer-use rule to ~/.claude/CLAUDE.md
#   ./install.sh --no-claude-md  skip the CLAUDE.md rule
#   ./install.sh --no-skill      skip the skill in ~/.claude/skills/puppet
#   ./install.sh --desktop       also add puppet to Claude Desktop (quit Claude Desktop first)
#   ./install.sh --menubar       also build the menu bar app into ~/Applications, start it, and start it at login
#
# Optional env vars, baked into the MCP server config when set:
#   PUPPET_IDLE_TURN_MS, PUPPET_NATIVE_PROMPTS, PUPPET_MAX_OUTPUT_CHARS, PUPPET_SANDBOX,
#   PUPPET_DISABLE_ANALYTICS, PUPPET_HELPERS, PUPPET_SNAPSHOTS, CODEX_HOME
# PUPPET_NODE picks the node binary (default: Homebrew's node, then the first node on PATH).
set -euo pipefail

SERVER_NAME="puppet"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.claude/mcp"
WRAPPER="$INSTALL_DIR/puppet-server.mjs"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
SKILL_DIR="$HOME/.claude/skills/puppet"
END_TURN="$INSTALL_DIR/puppet-end-turn.mjs"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
PLUGIN_ROOT="$CODEX_HOME_DIR/plugins/cache/openai-bundled/unified-computer-use"

add_claude_md=1
add_skill=1
add_desktop=0
add_menubar=0
for arg in "$@"; do
  case "$arg" in
    --no-claude-md) add_claude_md=0 ;;
    --no-skill) add_skill=0 ;;
    --desktop) add_desktop=1 ;;
    --menubar) add_menubar=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1" >&2; exit 1; }

echo "Checking requirements"

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS only (Codex Computer Use ships with the macOS ChatGPT app)."
ok "macOS $(sw_vers -productVersion)"

# The Node path is baked into the MCP config, so prefer a package-manager install that survives
# version-manager and tool cleanups over whatever node comes first on PATH.
NODE="${PUPPET_NODE:-}"
if [[ -z "$NODE" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]] && (( $("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) >= 18 )); then
      NODE="$candidate"
      break
    fi
  done
fi
[[ -n "$NODE" ]] || NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || fail "Node.js 18+ not found on PATH. Install it (e.g. brew install node) and re-run."
node_major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( node_major >= 18 )) || fail "Node.js 18+ required, found $("$NODE" --version) at $NODE."
ok "Node $("$NODE" --version) at $NODE"
case "$("$NODE" -p 'process.execPath')" in
  *"/.nvm/"*|*"/.fnm/"*|*"/.volta/"*|*"/.asdf/"*|"$HOME"/.*)
    echo "    note: this Node lives in a version manager or a hidden folder; re-run install.sh if it is removed," \
      "or set PUPPET_NODE to a stable node." ;;
esac

command -v claude >/dev/null || fail "Claude Code CLI ('claude') not found on PATH."
ok "Claude Code $(claude --version 2>/dev/null | head -1)"

plugin_json="$("$NODE" -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  let dirs = [];
  try { dirs = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch {}
  for (const d of dirs) {
    const f = path.join(root, d, ".mcp.json");
    try { if (JSON.parse(fs.readFileSync(f, "utf8")).mcpServers?.cua_repl?.command) { console.log(f); break; } } catch {}
  }' "$PLUGIN_ROOT")"
[[ -n "$plugin_json" ]] || fail "Codex Computer Use plugin not found under $PLUGIN_ROOT.
    Install the ChatGPT desktop app, open Codex, and turn on Computer Use once, then re-run."
ok "Codex Computer Use plugin: $plugin_json"

# Claude Desktop keeps its config in memory and writes it back when it saves its settings, which
# silently undoes an edit made while it runs. -a: macOS pgrep skips its own ancestors by default,
# and this script may run from a Claude Desktop terminal.
if (( add_desktop )) && pgrep -a -x Claude >/dev/null; then
  fail "Claude Desktop is running. Quit it (Cmd+Q), then re-run with --desktop from a terminal."
fi

echo "Installing"

# Puppet was called codex-cu before: replace that install (same tools, new names).
if claude mcp get codex-cu >/dev/null 2>&1 || [[ -f "$INSTALL_DIR/codex-cu-wrapper.mjs" ]]; then
  for scope in user local project; do claude mcp remove codex-cu -s "$scope" >/dev/null 2>&1 || true; done
  [[ -f "$INSTALL_DIR/codex-cu-approvals.json" && ! -f "$INSTALL_DIR/puppet-approvals.json" ]] &&
    cp "$INSTALL_DIR/codex-cu-approvals.json" "$INSTALL_DIR/puppet-approvals.json"
  # The old rule in ~/.claude/CLAUDE.md names tools that no longer exist.
  [[ -f "$CLAUDE_MD" ]] && "$NODE" -e '
    const fs = require("fs"), file = process.argv[1];
    const text = fs.readFileSync(file, "utf8");
    const begin = "<!-- codex-cu:begin -->", end = "<!-- codex-cu:end -->";
    const start = text.indexOf(begin), stop = text.indexOf(end);
    if (start === -1 || stop < start) process.exit(0);
    const out = (text.slice(0, start).trimEnd() + "\n\n" + text.slice(stop + end.length).trimStart()).trim();
    fs.writeFileSync(file, out ? out + "\n" : "");
  ' "$CLAUDE_MD"
  # Claude Desktop may still run the old script until it is re-added with --desktop.
  if (( add_desktop )) || ! grep -q "codex-cu-wrapper.mjs" "$DESKTOP_CONFIG" 2>/dev/null; then
    rm -f "$INSTALL_DIR"/codex-cu-wrapper.mjs "$INSTALL_DIR"/codex-cu-wrapper.state.json "$INSTALL_DIR"/codex-cu-activity.jsonl \
      "$INSTALL_DIR"/codex-cu-approvals.json
  else
    echo "    note: Claude Desktop still uses codex-cu; quit it and re-run with --desktop to switch it to puppet."
  fi
  rm -rf "$HOME/.claude/skills/codex-cu"
  pkill -x codex-cu-menu 2>/dev/null || true
  rm -rf "$HOME/Applications/codex-cu Menu.app"
  [[ -e "$HOME/Applications/Puppet.app/Contents/MacOS/codex-cu-menu" ]] && rm -rf "$HOME/Applications/Puppet.app"
  rm -f "$HOME/Library/LaunchAgents/com.tofunori.codex-cu-menu.plist"
  ok "Replaced the earlier codex-cu install"
  if grep -q "codex-cu-end-turn.mjs" "$HOME/.claude/settings.json" 2>/dev/null; then
    echo "    note: your Stop hook in ~/.claude/settings.json still runs codex-cu-end-turn.mjs;" \
      "change it to $END_TURN (the old script is kept until then)."
  fi
fi

mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/puppet-server.mjs" "$WRAPPER"
cp "$REPO_DIR/puppet-end-turn.mjs" "$END_TURN"
cp "$REPO_DIR/puppet-kernel.js" "$REPO_DIR/puppet-kernel.md" "$INSTALL_DIR/"
chmod +x "$WRAPPER" "$END_TURN"
ok "Wrapper copied to $WRAPPER"

server_json="$("$NODE" -e '
  const [node, wrapper] = process.argv.slice(1);
  const env = {};
  for (const k of ["PUPPET_IDLE_TURN_MS", "PUPPET_NATIVE_PROMPTS", "PUPPET_MAX_OUTPUT_CHARS", "PUPPET_SANDBOX", "PUPPET_DISABLE_ANALYTICS", "PUPPET_HELPERS", "PUPPET_SNAPSHOTS", "CODEX_HOME"]) if (process.env[k]) env[k] = process.env[k];
  console.log(JSON.stringify({ type: "stdio", command: node, args: [wrapper], ...(Object.keys(env).length ? { env } : {}) }));
' "$NODE" "$WRAPPER")"
claude mcp remove "$SERVER_NAME" -s user >/dev/null 2>&1 || true
claude mcp add-json --scope user "$SERVER_NAME" "$server_json" >/dev/null
ok "Registered user MCP server '$SERVER_NAME'"

if (( add_skill )); then
  mkdir -p "$SKILL_DIR"
  cp "$REPO_DIR/skills/puppet/SKILL.md" "$SKILL_DIR/SKILL.md"
  ok "Skill copied to $SKILL_DIR"
fi

if (( add_desktop )); then
  backup="$("$NODE" -e '
    const fs = require("fs"), path = require("path");
    const [file, serverJson] = process.argv.slice(1);
    let config = {};
    let backup = "";
    if (fs.existsSync(file)) {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      backup = `${file}.bak-${stamp}`;
      fs.copyFileSync(file, backup);
    }
    const { command, args, env } = JSON.parse(serverJson);
    (config.mcpServers ??= {})["puppet"] = { command, args, ...(env ? { env } : {}) };
    delete config.mcpServers["codex-cu"]; // the earlier name
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    console.log(backup);
  ' "$DESKTOP_CONFIG" "$server_json")"
  ok "Added puppet to Claude Desktop${backup:+ (backup: $backup)}"
fi

if (( add_claude_md )); then
  result="$("$NODE" -e '
    const fs = require("fs"), path = require("path");
    const [file, snippetFile] = process.argv.slice(1);
    const begin = "<!-- puppet:begin -->", end = "<!-- puppet:end -->";
    const block = `${begin}\n${fs.readFileSync(snippetFile, "utf8").trim()}\n${end}`;
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch {}
    const start = text.indexOf(begin), stop = text.indexOf(end);
    if (start !== -1 && stop > start) {
      text = text.slice(0, start) + block + text.slice(stop + end.length);
      console.log("updated");
    } else if (text.includes("mcp__puppet__js")) {
      console.log("skipped"); process.exit(0);
    } else {
      text = (text.trim() ? text.trimEnd() + "\n\n" : "") + block + "\n";
      console.log("added");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  ' "$CLAUDE_MD" "$REPO_DIR/claude-md-snippet.md")"
  case "$result" in
    added)   ok "Added the computer-use rule to $CLAUDE_MD" ;;
    updated) ok "Updated the computer-use rule in $CLAUDE_MD" ;;
    skipped) ok "$CLAUDE_MD already mentions puppet outside the managed block; left it unchanged" ;;
  esac
fi

if (( add_menubar )); then
  command -v swiftc >/dev/null || fail "swiftc not found: install the Xcode command line tools (xcode-select --install)."
  app="$("$REPO_DIR/menubar/build.sh" "$HOME/Applications")"
  ok "Menu bar app built: $app"
  agent="$HOME/Library/LaunchAgents/io.github.tofunori.puppet.plist"
  mkdir -p "$(dirname "$agent")"
  cat > "$agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>io.github.tofunori.puppet</string>
	<key>ProgramArguments</key>
	<array><string>$app/Contents/MacOS/puppet-menu</string></array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
PLIST
  ok "Starts at login ($agent)"
  pkill -x puppet-menu 2>/dev/null || true
  open "$app"
  ok "Menu bar app started"
fi

echo "Verifying"
if claude mcp get "$SERVER_NAME" 2>/dev/null | grep -q "Connected"; then
  ok "'$SERVER_NAME' is connected"
else
  claude mcp get "$SERVER_NAME" || true
  fail "'$SERVER_NAME' did not connect; see the output above."
fi

echo
echo "Done. Restart Claude Code to load the puppet tools."
