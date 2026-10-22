## Computer use

Use the `puppet` MCP server (`mcp__puppet__js`) for all desktop-app and browser control, Chrome included: it drives the user's real apps and their existing Chrome tabs through Codex Computer Use. Use Claude in Chrome or other computer-use tools only when the user names them.

- A Chrome tab bound by this session stays claimed until Claude finishes answering (with the Stop hook), `puppet` has been idle for 1 minute (`PUPPET_IDLE_TURN_MS`), or the session ends; the next call starts a new turn, so rebind tabs with `cua.getTab` after a pause. "Tab … is already part of browser session …" means another live session holds it.
- Permission prompts (browser sites and desktop apps) are MCP elicitations. Headless hosts decline them unseen, so the wrapper shows them as a native macOS dialog (Deny / Allow / Always Allow; set `PUPPET_NATIVE_PROMPTS=0` to forward them instead). Allow on a desktop-app prompt lasts until the session ends. Deny is saved for the rest of the session and does not appear on the Chrome settings page; the dialog stays open until answered and returns to the front every 10 seconds.
- `puppet` runs `~/.claude/mcp/puppet-server.mjs`, which launches Codex's `cua_repl` from the newest plugin version and adds the Codex turn metadata. Debug there if the server won't start or reports "Missing required Codex turn metadata".
