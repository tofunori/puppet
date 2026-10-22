#!/usr/bin/env bash
# Removes the puppet MCP server, the installed wrapper, the puppet skill, and the managed block in ~/.claude/CLAUDE.md.
set -euo pipefail

INSTALL_DIR="$HOME/.claude/mcp"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

claude mcp remove puppet -s user >/dev/null 2>&1 && echo "Removed MCP server 'puppet'" || echo "MCP server 'puppet' was not registered"
rm -f "$INSTALL_DIR/puppet-server.mjs" "$INSTALL_DIR/puppet-end-turn.mjs" "$INSTALL_DIR/puppet.state.json" "$INSTALL_DIR/puppet-approvals.json" "$INSTALL_DIR/puppet-activity.jsonl"
echo "Removed wrapper files from $INSTALL_DIR"
pkill -x puppet-menu 2>/dev/null || true
rm -rf "$HOME/Applications/Puppet.app" "$HOME/Applications/codex-cu Menu.app"
rm -f "$HOME/Library/LaunchAgents/io.github.tofunori.puppet.plist"
echo "Removed the menu bar app, if it was installed"
rm -f "$HOME/.claude/skills/puppet/SKILL.md"
rmdir "$HOME/.claude/skills/puppet" 2>/dev/null || true
echo "Removed the puppet skill"

if [[ -f "$CLAUDE_MD" ]] && command -v node >/dev/null; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const begin = "<!-- puppet:begin -->", end = "<!-- puppet:end -->";
    const text = fs.readFileSync(file, "utf8");
    const start = text.indexOf(begin), stop = text.indexOf(end);
    if (start === -1 || stop < start) { console.log(`No managed puppet block in ${file}`); process.exit(0); }
    const out = (text.slice(0, start).trimEnd() + "\n\n" + text.slice(stop + end.length).trimStart()).trim();
    fs.writeFileSync(file, out ? out + "\n" : "");
    console.log(`Removed the puppet block from ${file}`);
  ' "$CLAUDE_MD"
fi
