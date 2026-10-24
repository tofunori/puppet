#!/usr/bin/env node
// Stdio MCP wrapper that lets Claude Code use Codex's bundled computer-use server (cua_repl).
//
// - Launches cua_repl exactly as the newest unified-computer-use plugin's .mcp.json describes,
//   so Codex/ChatGPT updates are picked up on the next start.
// - Adds the `x-codex-turn-metadata` (session_id + turn_id) that the browser backend requires
//   to every tools/call. One wrapper process = one session; a turn lasts until the server has
//   been idle for IDLE_TURN_MS, like a Codex turn ending at its Stop hook.
// - Sends `turn_ended` when a turn goes idle and on shutdown so claimed Chrome tabs are released.
// - Also runs `SkyComputerUseClient turn-ended` at each turn end, as Codex does through its
//   `notify` hook. cua_repl's `turn_ended` only reaches the browser; this is what makes the Computer
//   Use service hide its virtual cursor in desktop apps.
// - Ends the turn at once on SIGUSR2, sent by puppet-end-turn.mjs from a Claude Code Stop hook,
//   so the cursor goes away as soon as Claude finishes answering.
// - Also ends the turn right after a kernel reset (a timed-out `js` call or `js_reset`). A reset
//   during a tab attach can leave that tab failing with "Debugger unattached" until its turn ends.
// - Records live sessions in a state file; if a previous wrapper died without ending its turn,
//   the next start ends it before launching the server.
// - Filters tools/list to the plugin's `enabled_tools`, minus tools marked hidden.
// - Shows confirmation elicitations (browser permission prompts) as a native macOS dialog, because
//   headless Claude Code hosts decline them unseen and the decline is then saved for the session.
//   Set PUPPET_NATIVE_PROMPTS=0 to forward them to the MCP client instead.
// - Remembers session-scoped approvals (every Computer Use app prompt) for the life of the wrapper,
//   so Allow covers the rest of the Claude Code session as it covers a Codex thread.
// - Keeps "Always Allow" on an app in puppet-approvals.json next to the wrapper; with
//   `"allApps": true` there, every app is allowed without asking. Browser prompts and high-risk
//   prompts still ask.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const PLUGIN_ROOT = path.join(CODEX_HOME, "plugins/cache/openai-bundled/unified-computer-use");
const SERVER_NAME = "cua_repl";
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "puppet.state.json");
// User data lives in a fixed folder, so a plugin install (whose folder changes with each version)
// keeps it too. PUPPET_DATA_DIR moves it.
const DATA_DIR = process.env.PUPPET_DATA_DIR || path.join(os.homedir(), ".claude/mcp");
const APPROVALS_FILE = path.join(DATA_DIR, "puppet-approvals.json");
const META_KEY = "x-codex-turn-metadata";
const NATIVE_PROMPTS = process.platform === "darwin" && process.env.PUPPET_NATIVE_PROMPTS !== "0";
const PROMPT_RAISE_SECONDS = 10;
const IDLE_TURN_MS = Number(process.env.PUPPET_IDLE_TURN_MS) || 60 * 1000;
const STOP_HOLD_MS = Number(process.env.PUPPET_STOP_HOLD_MS) || 60 * 1000;
const SKY_CLIENT_SUBPATH = "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
// Codex caps a `js` result at 25,000 tokens. About 80,000 characters stays under Claude Code's own
// 25,000-token limit, so the start of a long result is shown instead of the whole result being
// moved to a file. The full text goes to a private file whose path ends the cut result.
const MAX_OUTPUT_CHARS = Number(process.env.PUPPET_MAX_OUTPUT_CHARS) || 80000;
const OUTPUT_DIR = path.join(os.tmpdir(), "puppet-output");
const DISABLE_ANALYTICS = process.env.PUPPET_DISABLE_ANALYTICS === "1";
// Small functions declared in every new kernel, right after the call that printed the docs. Only
// top-level declarations carry from one `js` call to the next (globalThis does not).
// PUPPET_HELPERS=0 turns this off.
const HELPERS = process.env.PUPPET_HELPERS !== "0";
// After each action, a picture of the app or tab it acted on, for the menu bar app's small window.
// The Computer Use service takes it, with its own Screen Recording permission. PUPPET_SNAPSHOTS=0
// turns this off.
const SNAPSHOTS = process.env.PUPPET_SNAPSHOTS !== "0";
// The helpers and Puppet's additions to the cua API (selectors, stale-index checks, typeText that
// checks its work, tab.goto/waitFor/extractLinks...), with their documentation, which is added to
// the documentation the first call of a kernel prints. Both files sit next to this one.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const readBeside = (name) => {
  try {
    return fs.readFileSync(path.join(HERE, name), "utf8");
  } catch {
    return null;
  }
};
const KERNEL_CODE = readBeside("puppet-kernel.js") ?? `const cuLines = (text, pattern = "", limit = 30, width = 240) => {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
  return String(text).split("\\n").filter((l) => re.test(l)).slice(0, limit).map((l) => l.slice(0, width)).join("\\n");
};
const cuFind = async (target, pattern, limit = 30) =>
  cuLines(await target.getAXState({ emit: false, disableDiffing: true }), pattern, limit);
const cuKey = (combo) => String(combo).split("+").map((k) => ({
  cmd: "super", command: "super", "⌘": "super", opt: "alt", option: "alt", "⌥": "alt",
  control: "ctrl", "⌃": "ctrl", enter: "Return", return: "Return", esc: "Escape", escape: "Escape",
})[k.trim().toLowerCase()] ?? k.trim()).join("+");`;
const KERNEL_DOCS = readBeside("puppet-kernel.md");
// The first `js` call of a new kernel runs after Puppet's additions, in the same cell, so that it
// already has them (`getApp("Calculatrice")` by its localized name, for instance). The fake server
// in the tests splits the cell here.
const KERNEL_SEPARATOR = "\n;// ---- end of Puppet's additions; the call's own code follows ----\n";
// Lines in front of the call's own code, taken back out of the line numbers its errors report.
const KERNEL_LINES = (KERNEL_CODE + KERNEL_SEPARATOR).split("\n").length - 1;
// Without a sandbox profile from the client, node_repl runs the `js` kernel under `codex sandbox`:
// the whole disk read-only and no network. Codex sends its own profile with every call; with
// PUPPET_SANDBOX=off the wrapper sends "disabled", as a Codex set to danger-full-access does.
const SANDBOX_META_KEY = "codex/sandbox-state-meta";
const SANDBOX_OFF = process.env.PUPPET_SANDBOX === "off";
const SANDBOX_OFF_META = { permissionProfile: { type: "disabled" }, sandboxCwd: pathToFileURL(process.cwd()).href };

const log = (...args) => console.error("[puppet]", ...args);

function findServerConfig() {
  const versions = fs
    .readdirSync(PLUGIN_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    try {
      const file = path.join(PLUGIN_ROOT, version, ".mcp.json");
      const cfg = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.[SERVER_NAME];
      if (cfg?.command) return { version, file, cfg };
    } catch {}
  }
  throw new Error(`No ${SERVER_NAME} entry found in ${PLUGIN_ROOT}/*/.mcp.json`);
}

// The server must be the Node that ships inside ChatGPT.app, signed by OpenAI (team 2DC432GLL2):
// .mcp.json is a plain file in ~/.codex, and anything it names runs with the user's privileges.
// PUPPET_SKIP_SIGNATURE_CHECK=1 turns this off (for the tests, which use a fake server).
const OPENAI_REQUIREMENT = 'anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"';
const verifiedCommands = new Set();
function verifySignature(command) {
  if (process.platform !== "darwin" || process.env.PUPPET_SKIP_SIGNATURE_CHECK === "1") return;
  if (verifiedCommands.has(command)) return;
  const result = spawnSync("codesign", ["--verify", `-R=${OPENAI_REQUIREMENT}`, command], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} is not signed by OpenAI (${(result.stderr || result.error?.message || "").trim()})`);
  }
  verifiedCommands.add(command);
}

function spawnServer(cfg) {
  verifySignature(cfg.command);
  return spawn(cfg.command, cfg.args ?? [], {
    // PUPPET_DISABLE_ANALYTICS=1: cua_repl's JavaScript then sends no usage events to OpenAI and
    // skips the chatgpt.com account lookup that tags them. The Computer Use app's own events remain.
    env: { ...process.env, ...(cfg.env ?? {}), ...(DISABLE_ANALYTICS ? { NODE_REPL_DISABLE_ANALYTICS: "1" } : {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
}

const turnMeta = (session_id, turn_id) => JSON.stringify({ session_id, turn_id });

// ---------- state file ----------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).entries ?? [];
  } catch {
    return [];
  }
}

// Every wrapper of every Claude session shares this file, and several often start in the same
// second. Changes go through updateState: a lock directory around read-modify-write, and a write
// to a temporary file renamed over the old one, so a reader never sees half a file.
const LOCK_DIR = `${STATE_FILE}.lock`;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function updateState(change) {
  withLock(() => {
    const entries = change(readState());
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  });
}

const updateEntry = (patch) => updateState((entries) => entries.map((e) => (e.pid === process.pid ? { ...e, ...patch } : e)));

function withLock(work) {
  let locked = false;
  for (let i = 0; i < 200 && !locked; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      locked = true;
    } catch (e) {
      if (e.code !== "EEXIST") break;
      try {
        // A lock older than 10 s belongs to a wrapper that died while holding it.
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 10000) fs.rmdirSync(LOCK_DIR);
      } catch {}
      pause(10);
    }
  }
  if (!locked) log("state file lock not acquired; writing anyway");
  try {
    work();
  } finally {
    if (locked) fs.rmdirSync(LOCK_DIR);
  }
}

// ---------- activity, for the menu bar app (menubar/) ----------
// The state entry says what this session is doing now (busy, action, app); puppet-activity.jsonl
// keeps the last actions of every session, one JSON line each, trimmed to ACTIVITY_KEEP lines.

const ACTIVITY_FILE = path.join(path.dirname(STATE_FILE), "puppet-activity.jsonl");
const ACTIVITY_KEEP = 200;
const callsInFlight = new Map(); // tools/call id -> { title, app, t0 }
let lastApp = null;
let appendsSinceTrim = 0;

// The app or browser a call works on, read from the code: getApp("…"), createBrowserTab("…"),
// getTab(…, { browser: "…" }). Otherwise the last one this session named.
function appOf(code = "") {
  const app = /getApp\(\s*["'`]([^"'`]+)["'`]/.exec(code);
  // A browser named by its id is a browser whatever the id: "chrome", or "1" and "2" when the
  // extension runs in two Chromium browsers (Chrome and Vivaldi), so the menu bar app keeps it behind.
  const browser =
    /createBrowserTab\(\s*["'`]([^"'`]+)["'`]/.exec(code) ??
    /getBrowser\(\s*\{[^}]*\bid:\s*["'`]([^"'`]+)["'`]/.exec(code) ??
    /browser:\s*["'`]([^"'`]+)["'`]/.exec(code);
  if (app) lastApp = BROWSER_IDS.has(app[1]) ? "browser" : app[1];
  else if (browser) lastApp = "browser";
  // Tabs reached through a browser binding: user.claimTab, tabs.get/new/selected, getTab.
  else if (/\.user\.(claimTab|openTabs)\(|\.tabs\.(get|new|selected|list)\(|cua\.getTab\(/.test(code)) lastApp = "browser";
  return lastApp;
}
const BROWSER_IDS = new Set(["chrome", "edge", "iab", "dot"]);
// Every variable an app or tab is bound to in this kernel. The first call of a kernel binds one
// before Puppet's additions exist; loading them then decorates it in place.
const BINDING_RE = /(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:cua\.(?:getApp|getTab|createBrowserTab)|[A-Za-z_$][\w$.]*\.(?:user\.claimTab|tabs\.(?:get|new|selected)))\(/g;
const kernelBindings = new Set();

function activityStart(id, params) {
  const code = params?.arguments?.code ?? "";
  const title = params?.arguments?.title || (params?.name === "js_reset" ? "Reset the kernel" : code.split("\n")[0].slice(0, 80));
  const entry = { title, app: params?.name === "js" ? appOf(code) : lastApp, t0: Date.now() };
  const binding = [
    ...code.matchAll(
      /(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:cua\.(?:getApp|getTab|createBrowserTab)|[A-Za-z_$][\w$.]*\.(?:user\.claimTab|tabs\.(?:get|new|selected)))\(/g,
    ),
  ].at(-1);
  if (binding) targetBinding = binding[1];
  for (const m of code.matchAll(BINDING_RE)) kernelBindings.add(m[1]);
  callsInFlight.set(id, entry);
  updateEntry({ busy: true, turnActive: true, action: entry.title, app: entry.app, since: new Date(entry.t0).toISOString() });
}

function activityEnd(id, msg) {
  const call = callsInFlight.get(id);
  if (!call) return;
  callsInFlight.delete(id);
  const ok = !msg.error && msg.result?.isError !== true;
  const line = { t: new Date().toISOString(), pid: process.pid, session: SESSION_ID, title: call.title, app: call.app, ms: Date.now() - call.t0, ok };
  try {
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(line) + "\n");
    if (++appendsSinceTrim >= 50) trimActivity();
  } catch {}
  // The tab a browser call worked in ("Browser tab: 2036936507, Title: ..."): the menu bar app
  // selects it when the user clicks the floating window.
  const tab = call.app === "browser" ? resultTexts(msg).map((t) => /Browser tab: (\d+)/.exec(t)?.[1]).find(Boolean) : null;
  updateEntry({ busy: callsInFlight.size > 0, lastAt: line.t, lastOk: ok, ...(tab ? { tab } : {}) });
}

function trimActivity() {
  appendsSinceTrim = 0;
  withLock(() => {
    const lines = fs.readFileSync(ACTIVITY_FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length <= ACTIVITY_KEEP) return;
    const tmp = `${ACTIVITY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-ACTIVITY_KEEP).join("\n") + "\n");
    fs.renameSync(tmp, ACTIVITY_FILE);
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// ---------- minimal JSON-RPC client over a child's stdio ----------

function rpcClient(child, onOther) {
  let nextId = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return onOther?.(line, null);
    }
    if (msg && !("method" in msg) && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    } else {
      onOther?.(line, msg);
    }
  });
  const send = (obj) => child.stdin.writable && child.stdin.write(JSON.stringify(obj) + "\n");
  return {
    send,
    request(method, params, timeoutMs = 30000) {
      const id = `puppet-wrapper-${nextId++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
  };
}

async function initialize(rpc) {
  await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "puppet", version: "1" },
  });
  rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

const endTurn = (rpc, session_id, turn_id, timeoutMs) =>
  rpc.request(
    "tools/call",
    { name: "turn_ended", arguments: { hook_event_name: "Stop", session_id, turn_id } },
    timeoutMs,
  );

// Codex runs `SkyComputerUseClient turn-ended <payload>` from its `notify` setting after every turn;
// the Computer Use service then hides its virtual cursor for that thread (our session_id).
function endSkyTurn(cfg, session_id, turn_id, timeoutMs = 5000) {
  const app = cfg.env?.SKY_CUA_SERVICE_PATH || path.join(CODEX_HOME, "computer-use/Codex Computer Use.app");
  const client = path.join(app, SKY_CLIENT_SUBPATH);
  if (!fs.existsSync(client)) {
    log(`SkyComputerUseClient not found at ${client}; the cursor may stay visible`);
    return Promise.resolve();
  }
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": session_id,
    "turn-id": turn_id,
    cwd: process.cwd(),
    "input-messages": [],
    "last-assistant-message": "",
  });
  return new Promise((resolve) => {
    const proc = spawn(client, ["turn-ended", payload], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      log(`SkyComputerUseClient turn-ended failed: ${e.message}`);
      resolve();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) log(`SkyComputerUseClient turn-ended exited ${code}: ${err.trim()}`);
      resolve();
    });
  });
}

// End turns left behind by wrappers that died without shutting down. turn_ended only reaches
// the extension once this process has talked to the browser under that session, hence tabs.list().
async function cleanupStaleSessions(cfg, stale) {
  const child = spawnServer(cfg);
  const rpc = rpcClient(child);
  try {
    await initialize(rpc);
    for (const { session_id, turn_id } of stale) {
      await endSkyTurn(cfg, session_id, turn_id);
      try {
        await rpc.request("tools/call", {
          name: "js",
          arguments: { code: 'await (await cua.getBrowser({ id: "chrome" })).tabs.list();' },
          _meta: { [META_KEY]: turnMeta(session_id, turn_id) },
        });
        await endTurn(rpc, session_id, turn_id, 10000);
        log(`ended stale session ${session_id}`);
      } catch (e) {
        log(`could not end stale session ${session_id}: ${e.message}`);
      }
    }
  } catch (e) {
    log(`stale-session cleanup failed: ${e.message}`);
  } finally {
    child.kill();
  }
}

// ---------- native permission prompts ----------

// JXA NSAlert: stays open until answered and is raised to the front every PROMPT_RAISE_SECONDS.
const DIALOG_SCRIPT = `ObjC.import("AppKit");
function run([text, title, allowAlways, raiseSeconds, critical]) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  const alert = $.NSAlert.alloc.init;
  alert.messageText = title;
  alert.informativeText = text;
  alert.alertStyle = critical === "1" ? $.NSAlertStyleCritical : $.NSAlertStyleWarning;
  const buttons = allowAlways === "1" ? ["Allow", "Always Allow", "Deny"] : ["Allow", "Deny"];
  buttons.forEach((button) => alert.addButtonWithTitle(button));
  // Lay out and center before the first raise; ordering front first shows it at the screen origin.
  // NSWindow.center sits above the middle, so center on the visible frame exactly.
  alert.layout;
  const screen = ($.NSScreen.mainScreen.isNil() ? alert.window.screen : $.NSScreen.mainScreen).visibleFrame;
  const size = alert.window.frame.size;
  alert.window.setFrameOrigin($.NSMakePoint(
    screen.origin.x + (screen.size.width - size.width) / 2,
    screen.origin.y + (screen.size.height - size.height) / 2,
  ));
  const raise = () => {
    app.activateIgnoringOtherApps(true);
    alert.window.orderFrontRegardless;
  };
  const timer = $.NSTimer.timerWithTimeIntervalRepeatsBlock(Number(raiseSeconds), true, raise);
  $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSModalPanelRunLoopMode);
  raise();
  const response = Number(alert.runModal);
  timer.invalidate;
  return buttons[response - 1000] ?? "dismissed";
}`;

const openDialogs = new Map();

function isConfirmation(params) {
  if (params?.mode === "url") return false;
  const properties = params?.requestedSchema?.properties;
  return !properties || Object.keys(properties).length === 0;
}

function showDialog(requestId, text, title, allowAlways, critical) {
  return new Promise((resolve) => {
    const dialog = spawn(
      "osascript",
      ["-l", "JavaScript", "-e", DIALOG_SCRIPT, text, title, allowAlways ? "1" : "0", String(PROMPT_RAISE_SECONDS), critical ? "1" : "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    openDialogs.set(requestId, dialog);
    let out = "";
    let err = "";
    dialog.stdout.on("data", (d) => (out += d));
    dialog.stderr.on("data", (d) => (err += d));
    dialog.on("error", (e) => resolve({ error: e.message }));
    dialog.on("close", (code, signal) => {
      openDialogs.delete(requestId);
      resolve(code === 0 ? { choice: out.trim() } : { error: err.trim() || `exit ${code ?? signal}` });
    });
  });
}

function closeDialog(requestId) {
  openDialogs.get(requestId)?.kill();
  openDialogs.delete(requestId);
}

// A dismissed or failed prompt is answered with `cancel`, which the browser service does not persist.
const cancelledPrompts = new Set();

// Prompts approved for this session. Computer Use asks before every action on a desktop app and
// leaves remembering a `persist: "session"` approval to the client, as Codex does for its thread.
// Keyed without tool_name so one approval covers every action on that app.
const sessionApprovals = new Set();

function approvalKey(params, meta) {
  return JSON.stringify([meta.connector_id ?? null, params.message ?? null, meta.tool_params ?? null]);
}

// Apps allowed for good: { "allApps": true } or { "apps": ["Microsoft Outlook", ...] }. Computer Use
// does not keep "Always Allow" for a desktop app itself, so the wrapper does.
function readApprovals() {
  try {
    const saved = JSON.parse(fs.readFileSync(APPROVALS_FILE, "utf8"));
    return { allApps: saved.allApps === true, apps: Array.isArray(saved.apps) ? saved.apps : [] };
  } catch {
    return { allApps: false, apps: [] };
  }
}

// The app named by a Computer Use app prompt ("Allow Computer Use to use \"X\"?"), or null for any
// other prompt. High-risk prompts are never treated as app prompts.
function promptedApp(params, meta) {
  if (meta.riskLevel === "high") return null;
  return /^Allow Computer Use to use "(.+)"\?$/.exec(params.message ?? "")?.[1] ?? null;
}

function replyToElicitation(id, result) {
  child?.stdin.writable && child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

async function answerElicitation(msg) {
  const params = msg.params ?? {};
  const meta = params._meta ?? params.meta ?? {};
  const persist = [meta.persist].flat();
  const sessionScoped = persist.includes("session");
  const key = approvalKey(params, meta);
  if (sessionScoped && sessionApprovals.has(key)) {
    replyToElicitation(msg.id, { action: "accept", content: {}, _meta: { persist: "session" } });
    return;
  }
  const app = promptedApp(params, meta);
  const saved = readApprovals();
  if (app && (saved.allApps || saved.apps.includes(app))) {
    if (sessionScoped) sessionApprovals.add(key);
    log(`permission prompt "${params.message}": allowed by ${APPROVALS_FILE}`);
    replyToElicitation(msg.id, { action: "accept", content: {}, ...(sessionScoped ? { _meta: { persist: "session" } } : {}) });
    return;
  }
  const title = meta.connector_name ? `${meta.connector_name} permission` : "Codex Computer Use";
  // Computer Use sends a risk level, sometimes a warning subtitle, and the parameters to show (the app).
  const lines = [params.message || "Allow this action?"];
  if (meta.subtitle) lines.push("", meta.subtitle);
  if (meta.tool_title) lines.push("", meta.tool_title);
  const shown = Array.isArray(meta.tool_params_display) ? meta.tool_params_display : [];
  for (const p of shown) if (p?.value != null) lines.push(`${p.display_name ?? p.name}: ${p.value}`);
  if (meta.riskLevel) lines.push("", `Risk: ${meta.riskLevel}`);
  if (sessionScoped) lines.push("", "Allow applies until this Claude session ends.");
  const critical = meta.riskLevel === "high";
  const { choice, error } = await showDialog(msg.id, lines.join("\n"), title, persist.includes("always") || app != null, critical);
  if (cancelledPrompts.delete(msg.id)) return;
  if (error) log(`permission dialog failed: ${error}`);
  let result = { action: "cancel" };
  if (choice === "Deny") result = { action: "decline" };
  else if (choice === "Allow")
    result = { action: "accept", content: {}, ...(sessionScoped ? { _meta: { persist: "session" } } : {}) };
  else if (choice === "Always Allow")
    result = { action: "accept", content: {}, _meta: { persist: persist.includes("always") ? "always" : "session" } };
  if (sessionScoped && result.action === "accept") sessionApprovals.add(key);
  if (choice === "Always Allow" && app) saveApprovedApp(app);
  log(`permission prompt "${params.message}": ${choice ?? "failed"} -> ${result.action}`);
  replyToElicitation(msg.id, result);
}

function saveApprovedApp(app) {
  const saved = readApprovals();
  if (saved.apps.includes(app)) return;
  saved.apps.push(app);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(APPROVALS_FILE, JSON.stringify(saved, null, 2) + "\n");
  } catch (error) {
    log(`could not save the approval for ${app}: ${error.message}`);
  }
}

// ---------- main ----------

let { version, file, cfg } = findServerConfig();
log(`using ${SERVER_NAME} from ${file}`);

const SESSION_ID = randomUUID();
let turnId = randomUUID();
let turnUsed = false;
let idleTimer = null;
const pendingCalls = new Map(); // tools/call id -> tool name
let endTurnWhenIdle = false;

const enabledTools = Array.isArray(cfg.enabled_tools) ? new Set(cfg.enabled_tools) : null;
const toolsListIds = new Set();
const clientQueue = [];
let child = null;
let rpc = null;
let ready = false; // false while a restarted server is being initialized; client lines wait in clientQueue
let initRequest = null; // the client's initialize params, replayed to a restarted server
let initialized = false;
let shuttingDown = false;

const clientIn = readline.createInterface({ input: process.stdin });
clientIn.on("line", (line) => {
  if (answeredBeforeInitialize(line)) return;
  child && ready ? forwardToServer(line) : clientQueue.push(line);
});

// cua_repl (rmcp) exits on any request that arrives before `initialize`. Claude Code first sends a
// `server/discover` probe and, when the server dies, restarts it, which costs 10 to 20 s at startup.
// Answer such requests here so the client falls back to a plain `initialize` at once.
let sawInitialize = false;
function answeredBeforeInitialize(line) {
  if (sawInitialize) return false;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return false;
  }
  if (!msg || Array.isArray(msg) || typeof msg.method !== "string") return false;
  if (msg.method === "initialize") {
    sawInitialize = true;
    return false;
  }
  if (!("id" in msg)) return true; // a notification before initialize: drop it
  const reply =
    msg.method === "ping"
      ? { jsonrpc: "2.0", id: msg.id, result: {} }
      : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  process.stdout.write(JSON.stringify(reply) + "\n");
  return true;
}
clientIn.on("close", () => shutdown(0));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(0));
process.on("SIGUSR2", () => {
  clearStop();
  if (child) endTurnNow();
});
process.on("SIGUSR1", () => child && stopFromMenu());

// The stop button: what runs now finishes (the service has no way to cut a call short), nothing
// starts after it. Claude reads why in the refusal and answers the user.
let stoppedAt = 0;
function stopFromMenu() {
  stoppedAt = Date.now();
  log("stopped from the menu bar app");
  updateEntry({ stopped: true });
  endTurnNow();
}

function clearStop() {
  if (!stoppedAt) return;
  stoppedAt = 0;
  updateEntry({ stopped: false });
}

function refuseWhileStopped(m) {
  if (!stoppedAt || m?.method !== "tools/call" || !("id" in m)) return false;
  if (Date.now() - stoppedAt > STOP_HOLD_MS) {
    clearStop();
    return false;
  }
  stoppedAt = Date.now();
  const text = "[puppet] The user stopped Puppet from its floating window. Do not use the computer again in this answer: say that you stopped, and wait for their next message.";
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: true } }) + "\n");
  return true;
}

function forwardToServer(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return child.stdin.write(line + "\n");
  }
  if (refuseWhileStopped(msg)) return;
  // The first call of a turn, after ChatGPT installed a newer Computer Use: switch to it before the
  // call, or the call goes to a server whose plugin folder is gone ("native pipe startup failed").
  if (!turnUsed && !Array.isArray(msg) && msg?.method === "tools/call" && newerPluginInstalled()) {
    clientQueue.unshift(line);
    replaceServer("update").catch((e) => log(`update failed: ${e.message}`));
    return;
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    if (m?.method === "tools/call") {
      m.params = { ...m.params, _meta: callMeta(m.params?._meta) };
      turnUsed = true;
      pendingCalls.set(m.id, m.params?.name);
      activityStart(m.id, m.params);
      prefixKernel(m);
      clearTimeout(idleTimer);
    } else if (m?.method === "initialize") {
      // cua_repl only requests approvals from clients that advertise form elicitation.
      if (NATIVE_PROMPTS) m.params = { ...m.params, capabilities: { elicitation: {}, ...m.params?.capabilities } };
      initRequest = m.params;
      updateEntry({ client: m.params?.clientInfo?.title ?? m.params?.clientInfo?.name ?? null });
    } else if (m?.method === "tools/list") {
      toolsListIds.add(m.id);
    } else if (m?.method === "notifications/initialized") {
      initialized = true;
    }
  }
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function forwardToClient(line, msg) {
  if (NATIVE_PROMPTS && msg?.method === "elicitation/create" && "id" in msg && isConfirmation(msg.params)) {
    answerElicitation(msg);
    return;
  }
  if (msg?.method === "notifications/cancelled" && openDialogs.has(msg.params?.requestId)) {
    cancelledPrompts.add(msg.params.requestId);
    closeDialog(msg.params.requestId);
  }
  if (msg && !("method" in msg) && pendingCalls.has(msg.id)) {
    const tool = pendingCalls.get(msg.id);
    if (tool === "js" && heldDocs && msg.result) {
      msg.result.content = [...heldDocs, ...(msg.result.content ?? [])];
      heldDocs = null;
    }
    // One hidden call at a time: the additions first when a new kernel lacks them, then the snapshot.
    const fresh = tool === "js" && freshKernel(msg);
    const check = tool === "js" && kernelOutcome(msg, fresh);
    if (check) setTimeout(() => ensureKernel().then(takeSnapshot), 0);
    if (tool === "js") {
      if (fresh) addKernelDocs(msg);
      dropDuplicateImages(msg);
      addErrorHint(msg);
      capOutput(msg);
      line = JSON.stringify(msg);
    }
    pendingCalls.delete(msg.id);
    activityEnd(msg.id, msg);
    if (tool === "js_reset" || (tool === "js" && isKernelReset(msg))) {
      targetBinding = null;
      kernelBindings.clear();
      kernelLoaded = false;
    }
    else if (tool === "js" && !check && !msg.error && msg.result?.isError !== true) setTimeout(takeSnapshot, 0);
    if (tool === "js_reset" || (tool === "js" && (isKernelReset(msg) || isUserStop(msg)))) endTurnWhenIdle = true;
    if (pendingCalls.size === 0) {
      clearTimeout(idleTimer);
      if (endTurnWhenIdle) {
        endTurnWhenIdle = false;
        endIdleTurn("reset or stop hook");
      } else {
        idleTimer = setTimeout(endIdleTurn, IDLE_TURN_MS);
        idleTimer.unref();
      }
    }
  }
  if (msg && !("method" in msg) && toolsListIds.delete(msg.id) && Array.isArray(msg.result?.tools)) {
    msg.result.tools = msg.result.tools.filter((t) => {
      const hidden = Array.isArray(t._meta?.ui?.visibility) && t._meta.ui.visibility.length === 0;
      return !hidden && (!enabledTools || enabledTools.has(t.name));
    });
    line = JSON.stringify(msg);
  }
  process.stdout.write(line + "\n");
}

// Puppet's additions to the documentation a new kernel prints, right after it.
function addKernelDocs(msg) {
  if (!KERNEL_DOCS) return false;
  const content = msg.result.content;
  const at = content.findIndex((c) => typeof c?.text === "string" && c.text.startsWith("## Computer Use"));
  content.splice(at + 1, 0, { type: "text", text: KERNEL_DOCS });
  return true;
}

// getScreenshot() already shows its image; `nodeRepl.emitImage(await tab.getScreenshot())` showed
// the same picture twice. Keep the first of identical images.
function dropDuplicateImages(msg) {
  const content = msg.result?.content;
  if (!Array.isArray(content)) return false;
  const seen = new Set();
  const kept = content.filter((c) => {
    if (c?.type !== "image" || typeof c.data !== "string") return true;
    if (seen.has(c.data)) return false;
    seen.add(c.data);
    return true;
  });
  if (kept.length === content.length) return false;
  msg.result.content = kept;
  return true;
}

const resultTexts = (msg) =>
  [msg.error?.message, ...(msg.result?.content ?? []).map((c) => c?.text)].filter((t) => typeof t === "string");

// Cut the text of a result past MAX_OUTPUT_CHARS, keeping its start (the first call's documentation
// comes first), and save the whole text where the model can read it. Images are left alone.
function capOutput(msg) {
  const texts = (msg.result?.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string");
  const total = texts.reduce((n, c) => n + c.text.length, 0);
  if (total <= MAX_OUTPUT_CHARS) return false;
  let file = "not saved";
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
    file = path.join(OUTPUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.txt`);
    fs.writeFileSync(file, texts.map((c) => c.text).join("\n\n"), { mode: 0o600 });
  } catch (e) {
    log(`could not save the full output: ${e.message}`);
  }
  let budget = MAX_OUTPUT_CHARS;
  for (const c of texts) {
    c.text = c.text.slice(0, budget);
    budget -= c.text.length;
  }
  msg.result.content = msg.result.content.filter((c) => c?.type !== "text" || c.text);
  msg.result.content.push({
    type: "text",
    text:
      `[puppet] Output cut at ${MAX_OUTPUT_CHARS} of ${total} characters. Full text: ${file}. ` +
      "Next time print only what you need, for example getAXState({ emit: false }) and a few lines of it.",
  });
  return true;
}

// What to do next for the errors Computer Use reports in plain words. The service's error codes
// (-10000 to -10020) do not reach the result; only these messages do.
const ERROR_HINTS = [
  [/Invalid app:/, "Find the app's exact name or bundle id with `await cua.listApps({ emit: false })`, then call getApp with it."],
  [/is an invalid element ID|element ID is no longer valid|is stale or missing/, "The element index is stale: the tree was renumbered. Read it again with getAXState({ full: true }), or target the element by selector, for example click({ id: \"…\" }) or click({ text: \"…\", role: \"button\" })."],
  [/was not approved to use|not approved to record/, "The user declined this. Do not retry; ask them what to do."],
  [/explicitly stopped by the user/, "The user pressed Esc. Stop, say so, and wait for their next message."],
  [/unavailable because the current turn ended/, "The turn has ended. Call again: the next call starts a new turn."],
  [/cgWindowNotFound/, "The app has no window on screen, or the screen is locked. Open a window first (for example a new document, or `open -a` the app), or ask the user to unlock the screen, then call getApp again."],
  [/Accessibility|Screen Recording|permissionsNotGranted|permissionsPending/i, "Ask the user to grant Codex Computer Use Accessibility and Screen Recording in System Settings > Privacy & Security."],
  [/screen is locked|screenLocked/i, "The screen is locked. Ask the user to unlock it."],
];

function addErrorHint(msg) {
  if (!msg.error && msg.result?.isError !== true) return false;
  // The documentation a new kernel prints with its first result mentions permissions too.
  const texts = resultTexts(msg).filter((t) => !t.startsWith("## Computer Use"));
  const hint = ERROR_HINTS.find(([pattern]) => texts.some((t) => pattern.test(t)))?.[1];
  if (!hint) return false;
  if (msg.error) msg.error.message = `${msg.error.message}\n[puppet] ${hint}`;
  else msg.result.content.push({ type: "text", text: `[puppet] ${hint}` });
  return true;
}

// Saved outputs older than a day are no longer useful to anyone.
function pruneSavedOutputs() {
  try {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      const file = path.join(OUTPUT_DIR, name);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(file);
    }
  } catch {}
}

// cua_repl reports a timed-out `js` call as "js execution timed out; kernel reset, ...".
function isKernelReset(msg) {
  return resultTexts(msg).some((t) => /kernel reset/i.test(t));
}

// The user pressed Esc (userStoppedSession, -10012) or took over the mouse or keyboard
// (userIntervened, -10016). The service then refuses this turn until a new one starts, as in Codex,
// where the turn ends there; end ours too so the next request gets a fresh turn id.
function isUserStop(msg) {
  return resultTexts(msg).some((t) => /explicitly stopped by the user|userStoppedSession|userIntervened|-1001[26]\b/.test(t));
}

// The same _meta for every call: our turn metadata, plus the sandbox profile when it is off. A call
// whose sandbox differs from the previous one makes node_repl reset the kernel.
function callMeta(clientMeta = {}) {
  const sandbox = SANDBOX_OFF && !clientMeta[SANDBOX_META_KEY] ? { [SANDBOX_META_KEY]: SANDBOX_OFF_META } : {};
  return { ...clientMeta, ...sandbox, [META_KEY]: turnMeta(SESSION_ID, turnId) };
}

// Whether this kernel has Puppet's additions. The first `js` call while it does not carries them
// (prefixKernel); a call that fails takes its declarations with it, so the server then checks.
let kernelLoaded = false;
const prefixedCalls = new Set();

function prefixKernel(m) {
  if (!HELPERS || kernelLoaded || prefixedCalls.size || m.params?.name !== "js" || typeof m.params.arguments?.code !== "string") return;
  m.params = { ...m.params, arguments: { ...m.params.arguments, code: KERNEL_CODE + KERNEL_SEPARATOR + m.params.arguments.code } };
  prefixedCalls.add(m.id);
}

// Settles kernelLoaded from a `js` result; true when the kernel must be checked (and the additions
// declared if they are missing) by a hidden call.
function kernelOutcome(msg, fresh) {
  if (!HELPERS) return false;
  if (prefixedCalls.delete(msg.id)) {
    const texts = resultTexts(msg);
    // The kernel was not new after all: the additions are there, the call's own code did not run.
    if (texts.some((t) => /'(?:cu|__cu)\w*' has already been declared/.test(t))) {
      kernelLoaded = true;
      msg.result?.content?.push({ type: "text", text: "[puppet] This kernel already had Puppet's additions, so your code did not run. Run the call again." });
      return false;
    }
    if (!msg.error && msg.result?.isError !== true) {
      kernelLoaded = true;
      return false;
    }
    shiftLines(msg);
    return true;
  }
  return fresh && !kernelLoaded;
}

// A first call that does not even parse ("let x = ;") never starts the kernel: the kernel then
// prints its documentation to the hidden check. It is held and shown with the next call's result.
let heldDocs = null;
const holdDocs = (reply) => {
  const docs = (reply?.result?.content ?? []).filter((c) => typeof c?.text === "string" && c.text.startsWith("## Computer Use"));
  if (docs.length) heldDocs = docs;
};

// The line numbers of a prefixed call's errors ("[722:8-722:9]: Unexpected token", "<anonymous>:722:8"),
// counted from the call's own code.
function shiftLines(msg) {
  const shift = (t) =>
    t
      .replace(/\[(\d+):(\d+)-(\d+):(\d+)\]/g, (all, a, b, c, d) => (Number(a) > KERNEL_LINES ? `[${a - KERNEL_LINES}:${b}-${c - KERNEL_LINES}:${d}]` : all))
      .replace(/(<anonymous>:)(\d+)(:\d+)/g, (all, p, l, r) => (Number(l) > KERNEL_LINES ? `${p}${l - KERNEL_LINES}${r}` : all));
  for (const c of msg.result?.content ?? []) if (typeof c?.text === "string") c.text = shift(c.text);
  if (typeof msg.error?.message === "string") msg.error.message = shift(msg.error.message);
}

async function ensureKernel() {
  try {
    const probe = await rpc.request(
      "tools/call",
      { name: "js", arguments: { code: "nodeRepl.write(typeof cuDecorate);", title: "puppet check" }, _meta: callMeta() },
      30000,
    );
    holdDocs(probe);
    if (resultTexts(probe).some((t) => t.trim() === "function")) kernelLoaded = true;
    else await loadHelpers();
  } catch (e) {
    log(`kernel check failed: ${e.message}`);
  }
}

// cua_repl prints its documentation once, on the first call of a new kernel, even when that call
// fails (`getApp("Calculatrice")` → "Invalid app"); the kernel stays, so a failed first call counts.
function freshKernel(msg) {
  return HELPERS && msg.result && resultTexts(msg).some((t) => t.startsWith("## Computer Use"));
}

// The variable the model last bound an app or tab to (`let app = await cua.getApp(...)`). Bindings
// carry between calls, so a hidden call can ask that target for a screenshot without printing its
// accessibility tree again. A kernel reset drops them.
let targetBinding = null;
let snapshotInFlight = false;
const SNAPSHOT_FILE = path.join(path.dirname(STATE_FILE), `puppet-snapshot-${process.pid}.img`);

async function takeSnapshot() {
  // A turn that ended as its last call returned (Esc, a reset, the stop button) already has a new
  // turn id: a snapshot then would open a Computer Use turn nobody ends, and its cursor would stay.
  if (!SNAPSHOTS || !targetBinding || snapshotInFlight || !rpc || !turnUsed) return;
  snapshotInFlight = true;
  const code = `{ const __cuShot = await ${targetBinding}.getScreenshot({ emit: false }); await nodeRepl.emitImage(__cuShot); }`;
  try {
    const reply = await rpc.request("tools/call", { name: "js", arguments: { code, title: "puppet snapshot" }, _meta: callMeta() }, 8000);
    const image = (reply.result?.content ?? []).find((c) => c?.type === "image" && c.data);
    if (!image) {
      targetBinding = null; // not an app or tab, or gone: wait for the next getApp/getTab
      return;
    }
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(image.data, "base64"), { mode: 0o600 });
    fs.renameSync(tmp, SNAPSHOT_FILE);
    updateEntry({ snapshot: path.basename(SNAPSHOT_FILE), snapshotAt: new Date().toISOString() });
  } catch (e) {
    log(`snapshot failed: ${e.message}`);
  } finally {
    snapshotInFlight = false;
  }
}

async function loadHelpers() {
  // A tab is decorated as a new object, so the variable is assigned again (a const one stays as it was).
  const adopt = [...kernelBindings].map((name) => `try { ${name} = await cuAdopt(${name}); } catch {}`).join("\n");
  const code = KERNEL_CODE + (adopt && /\bconst cuAdopt\b/.test(KERNEL_CODE) ? `\n${adopt}` : "");
  try {
    const reply = await rpc.request(
      "tools/call",
      { name: "js", arguments: { code, title: "puppet helpers" }, _meta: callMeta() },
      30000,
    );
    if (!heldDocs) holdDocs(reply);
    if (reply.error || reply.result?.isError) log(`helpers not loaded: ${JSON.stringify(reply.error ?? reply.result.content)}`);
    else kernelLoaded = true;
  } catch (e) {
    log(`helpers not loaded: ${e.message}`);
  }
}

function recordTurn() {
  updateEntry({ turn_id: turnId, turnActive: false, busy: false });
}

// End the idle turn so the extension releases its tabs and the service hides its cursor; the next
// call starts a new turn.
async function endIdleTurn(reason = "idle") {
  if (shuttingDown || pendingCalls.size || !turnUsed) return;
  const endedTurn = turnId;
  turnId = randomUUID();
  turnUsed = false;
  recordTurn();
  log(`ending turn ${endedTurn} (${reason})`);
  await Promise.all([
    endTurn(rpc, SESSION_ID, endedTurn, 5000).catch((e) => log(`turn_ended failed: ${e.message}`)),
    endSkyTurn(cfg, SESSION_ID, endedTurn),
  ]);
  // Between turns is the one moment a restart loses nothing in flight: pick up a ChatGPT update here.
  let newest = null;
  try {
    newest = findServerConfig();
  } catch {}
  if (newest && newest.version !== version && ready && !pendingCalls.size && !shuttingDown) await replaceServer("update");
}

// Sent by puppet-end-turn.mjs when Claude finishes answering (Claude Code Stop hook).
function endTurnNow() {
  clearTimeout(idleTimer);
  if (pendingCalls.size) endTurnWhenIdle = true;
  else endIdleTurn("stop hook");
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const requestId of [...openDialogs.keys()]) closeDialog(requestId);
  if (child && child.exitCode === null) {
    clearTimeout(idleTimer);
    if (initialized && turnUsed) {
      await Promise.all([
        endTurn(rpc, SESSION_ID, turnId, 5000).catch((e) => log(`turn_ended failed: ${e.message}`)),
        endSkyTurn(cfg, SESSION_ID, turnId),
      ]);
    }
    child.stdin.end();
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
  updateState((entries) => entries.filter((e) => e.pid !== process.pid));
  try {
    fs.unlinkSync(SNAPSHOT_FILE);
  } catch {}
  process.exit(code);
}

pruneSavedOutputs();
let stale = [];
updateState((entries) => {
  stale = entries.filter((e) => !isAlive(e.pid));
  return [
    ...entries.filter((e) => isAlive(e.pid)),
    // ppid lets the Stop hook find the wrappers that belong to its own Claude Code process.
    // cwd names the Claude session for the menu bar app ("/" for Claude Desktop chats).
    { pid: process.pid, ppid: process.ppid, session_id: SESSION_ID, turn_id: turnId, version, started: new Date().toISOString(), cwd: process.cwd() },
  ];
});
// ---------- server lifecycle: start, restart after a crash, replace after a ChatGPT update ----------

const recentCrashes = [];

function startServer() {
  const server = spawnServer(cfg);
  child = server;
  rpc = rpcClient(server, forwardToClient);
  server.on("exit", (code, signal) => {
    if (shuttingDown || server.replaced) return;
    log(`${SERVER_NAME} exited (code ${code}, signal ${signal})`);
    const now = Date.now();
    while (recentCrashes.length && now - recentCrashes[0] > 60000) recentCrashes.shift();
    recentCrashes.push(now);
    // Before the client's initialize there is nothing to replay; after three crashes in a minute
    // something is wrong. Either way exit, leaving our state entry so the next start ends this turn.
    if (!initRequest || recentCrashes.length > 3) process.exit(code ?? 1);
    restartServer("crash");
  });
}

// A new server knows nothing of this client: replay its initialize, then let queued lines through.
// Calls the old server never answered fail now so the client does not wait on them forever.
async function restartServer(reason) {
  ready = false;
  kernelLoaded = false;
  prefixedCalls.clear();
  heldDocs = null;
  for (const id of pendingCalls.keys()) {
    const error = { code: -32603, message: `${SERVER_NAME} restarted (${reason}); call the tool again` };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\n");
    activityEnd(id, { error });
  }
  pendingCalls.clear();
  if (turnUsed) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(endIdleTurn, IDLE_TURN_MS);
    idleTimer.unref();
  }
  try {
    ({ version, file, cfg } = findServerConfig());
    log(`restarting ${SERVER_NAME} (${reason}) from ${file}`);
    startServer();
  } catch (e) {
    log(`cannot restart: ${e.message}`);
    process.exit(1);
  }
  updateState((entries) => entries.map((e) => (e.pid === process.pid ? { ...e, version } : e)));
  try {
    await rpc.request("initialize", initRequest, 120000);
    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (e) {
    log(`re-initialize failed: ${e.message}`);
  }
  ready = true;
  for (const line of clientQueue.splice(0)) forwardToServer(line);
}

function newerPluginInstalled() {
  try {
    return findServerConfig().version !== version;
  } catch {
    return false;
  }
}

async function replaceServer(reason) {
  const old = child;
  old.replaced = true;
  ready = false;
  old.stdin.end();
  await Promise.race([
    new Promise((r) => old.once("exit", r)),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  if (old.exitCode === null) old.kill();
  await restartServer(reason);
}

if (!shuttingDown) {
  try {
    startServer();
  } catch (e) {
    log(`cannot start ${SERVER_NAME}: ${e.message}`);
    process.exit(1);
  }
  ready = true;
  for (const line of clientQueue.splice(0)) forwardToServer(line);
  // In the background: the client's connect budget is 30 s and this cleanup runs a whole second
  // cua_repl, so it must not delay this session's own server.
  if (stale.length) cleanupStaleSessions(cfg, stale).catch((e) => log(`stale-session cleanup failed: ${e.message}`));
}
