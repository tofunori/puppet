#!/usr/bin/env node
// Checks every piece puppet depends on and says what to do about each one that fails.
// Read-only: it changes nothing. Run with `node doctor.mjs` (or `npm run doctor`).

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const REPO = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const PLUGIN_ROOT = path.join(CODEX_HOME, "plugins/cache/openai-bundled/unified-computer-use");
const MCP_DIR = path.join(HOME, ".claude/mcp");
const SOCKET = path.join(HOME, "Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock");
const BROWSER_SOCKETS = "/tmp/codex-browser-use";
const DESKTOP_CONFIG = path.join(HOME, "Library/Application Support/Claude/claude_desktop_config.json");
const SKY_CLIENT_SUBPATH = "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

let failures = 0;
const ok = (msg) => console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
const warn = (msg, fix) => console.log(`  \x1b[33m!\x1b[0m ${msg}${fix ? `\n      ${fix}` : ""}`);
const fail = (msg, fix) => {
  failures++;
  console.log(`  \x1b[31m✘\x1b[0m ${msg}${fix ? `\n      ${fix}` : ""}`);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

console.log("Codex Computer Use");
let cfg = null;
try {
  const versions = fs.readdirSync(PLUGIN_ROOT).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    try {
      cfg = readJson(path.join(PLUGIN_ROOT, v, ".mcp.json")).mcpServers?.cua_repl;
      if (cfg?.command) {
        ok(`plugin ${v}`);
        break;
      }
    } catch {}
  }
} catch {}
if (!cfg?.command) {
  fail(`no plugin under ${PLUGIN_ROOT}`, "Open ChatGPT, go to Codex and turn on Computer Use once.");
} else {
  const sig = spawnSync("codesign", ["--verify", '-R=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', cfg.command], { encoding: "utf8" });
  if (sig.status === 0) ok(`server Node signed by OpenAI (${cfg.command})`);
  else fail(`server Node not signed by OpenAI: ${cfg.command}`, "Reinstall the ChatGPT app.");
  const skyApp = cfg.env?.SKY_CUA_SERVICE_PATH || path.join(CODEX_HOME, "computer-use/Codex Computer Use.app");
  if (fs.existsSync(path.join(skyApp, SKY_CLIENT_SUBPATH))) ok("SkyComputerUseClient present (clears the cursor)");
  else fail(`SkyComputerUseClient missing in ${skyApp}`, "Turn Computer Use off and on again in Codex.");
}
const running = spawnSync("pgrep", ["-x", "SkyComputerUseService"], { encoding: "utf8" }).stdout.trim();
if (running) ok(`Computer Use service running (pid ${running.split("\n").join(", ")})`);
else warn("Computer Use service not running", "It starts on the first action; if actions fail, open ChatGPT.");
try {
  if (fs.statSync(SOCKET).isSocket()) ok("service socket computeruse.sock present");
} catch {
  warn("service socket computeruse.sock not found", "Normal before the first action since ChatGPT started.");
}
try {
  const sockets = fs.readdirSync(BROWSER_SOCKETS).filter((f) => f.endsWith(".sock"));
  if (sockets.length) ok(`${sockets.length} browser extension socket(s) in ${BROWSER_SOCKETS}`);
  else warn("no browser extension connected", "Open a Chromium browser with the ChatGPT extension to drive tabs.");
} catch {
  warn("no browser extension connected", "Open a Chromium browser with the ChatGPT extension to drive tabs.");
}

console.log("Claude Code");
let registeredNode = null;
const installed = path.join(MCP_DIR, "puppet-server.mjs");
if (!fs.existsSync(installed)) fail(`wrapper not installed at ${installed}`, "Run ./install.sh");
else if (sha(installed) !== sha(path.join(REPO, "puppet-server.mjs"))) warn("installed wrapper differs from this checkout", "Run ./install.sh to install this version.");
else ok("installed wrapper matches this checkout");
for (const f of ["puppet-kernel.js", "puppet-kernel.md"]) {
  const file = path.join(MCP_DIR, f);
  if (!fs.existsSync(file)) warn(`${f} not installed: the cua additions (selectors, stale-index checks, tab.goto…) are off`, "Run ./install.sh");
  else if (sha(file) !== sha(path.join(REPO, f))) warn(`installed ${f} differs from this checkout`, "Run ./install.sh to install this version.");
}
if (fs.existsSync(path.join(MCP_DIR, "puppet-end-turn.mjs"))) ok("Stop hook script installed");
else fail("Stop hook script missing", "Run ./install.sh");
try {
  const entry = readJson(path.join(HOME, ".claude.json")).mcpServers?.["puppet"];
  if (!entry) fail("puppet not registered", "Run ./install.sh");
  else if (!fs.existsSync(entry.command)) fail(`registered Node missing: ${entry.command}`, "Run ./install.sh");
  else {
    registeredNode = entry.command;
    ok(`registered with ${entry.command}`);
  }
} catch {
  fail("cannot read ~/.claude.json", "Run ./install.sh");
}
try {
  const stop = readJson(path.join(HOME, ".claude/settings.json")).hooks?.Stop ?? [];
  if (stop.some((g) => g.hooks?.some((h) => h.command?.includes("puppet-end-turn.mjs")))) ok("Stop hook in ~/.claude/settings.json");
  else warn("no Stop hook: the cursor stays until the idle delay", "See \"End the turn as soon as Claude finishes\" in the README.");
} catch {
  warn("cannot read ~/.claude/settings.json");
}
if (fs.existsSync(path.join(HOME, ".claude/skills/puppet/SKILL.md"))) ok("skill installed");
else warn("skill not installed", "Run ./install.sh");

console.log("Claude Desktop");
try {
  const entry = readJson(DESKTOP_CONFIG).mcpServers?.["puppet"];
  if (!entry) warn("puppet not in claude_desktop_config.json");
  else if (!fs.existsSync(entry.command)) fail(`Desktop Node missing: ${entry.command}`, "Fix the command in claude_desktop_config.json.");
  else if (registeredNode && entry.command !== registeredNode)
    warn(
      `Desktop uses ${entry.command}, Claude Code uses ${registeredNode}`,
      "Quit Claude Desktop (Cmd+Q), then run ./install.sh --desktop from Terminal.",
    );
  else ok(`configured with ${entry.command}`);
} catch {
  warn("no claude_desktop_config.json");
}

console.log("Sessions");
try {
  const entries = readJson(path.join(MCP_DIR, "puppet.state.json")).entries ?? [];
  const live = entries.filter((e) => isAlive(e.pid));
  ok(`${live.length} running wrapper(s)`);
  if (entries.length > live.length) warn(`${entries.length - live.length} orphaned session(s)`, "The next wrapper start ends them.");
} catch {
  ok("no running wrapper");
}

console.log(failures ? `\n${failures} problem(s) found.` : "\nAll good.");
process.exit(failures ? 1 : 0);
