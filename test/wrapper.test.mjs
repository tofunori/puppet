// Tests for puppet-server.mjs against a fake cua_repl. Run with `node --test test/`.
// Each test gets its own temporary CODEX_HOME (plugin cache + fake Computer Use client) and its own
// copy of the wrapper, so the state file never touches ~/.claude/mcp.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_SERVER = path.join(REPO, "test/fake-cua-repl.mjs");
const SKY_CLIENT = "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "puppet-test-"));
  const mcpDir = path.join(dir, "mcp");
  fs.mkdirSync(mcpDir);
  for (const f of ["puppet-server.mjs", "puppet-end-turn.mjs", "puppet-kernel.js", "puppet-kernel.md"]) fs.copyFileSync(path.join(REPO, f), path.join(mcpDir, f));
  const skyApp = path.join(dir, "Fake Computer Use.app");
  const client = path.join(skyApp, SKY_CLIENT);
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, `#!/bin/sh\nprintf '%s\\n' "$2" >> '${path.join(dir, "sky.log")}'\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    CODEX_HOME: path.join(dir, "codex"),
    PUPPET_NATIVE_PROMPTS: "0",
    PUPPET_SKIP_SIGNATURE_CHECK: "1",
    PUPPET_DATA_DIR: mcpDir,
    FAKE_LOG: path.join(dir, "server.log"),
  };
  const ctx = {
    dir,
    env,
    wrapper: path.join(mcpDir, "puppet-server.mjs"),
    endTurn: path.join(mcpDir, "puppet-end-turn.mjs"),
    stateFile: path.join(mcpDir, "puppet.state.json"),
    addPlugin(version) {
      const vdir = path.join(env.CODEX_HOME, "plugins/cache/openai-bundled/unified-computer-use", version);
      fs.mkdirSync(vdir, { recursive: true });
      const cua_repl = {
        command: process.execPath,
        args: [FAKE_SERVER],
        enabled_tools: ["js", "js_reset", "turn_ended"],
        env: { SKY_CUA_SERVICE_PATH: skyApp, FAKE_VERSION: version },
      };
      fs.writeFileSync(path.join(vdir, ".mcp.json"), JSON.stringify({ mcpServers: { cua_repl } }));
    },
    events: () => readLines(env.FAKE_LOG).map((l) => JSON.parse(l)),
    skyPayloads: () => readLines(path.join(dir, "sky.log")).map((l) => JSON.parse(l)),
    state: () => JSON.parse(fs.readFileSync(path.join(mcpDir, "puppet.state.json"), "utf8")).entries,
  };
  ctx.addPlugin("1.0");
  return ctx;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// An MCP client talking to one wrapper process. `viaProxy` puts a node process between the test and
// the wrapper, so the wrapper's parent is not one of this process's ancestors (another Claude session).
function connect(ctx, { env = {}, viaProxy = false } = {}) {
  const args = viaProxy
    ? ["-e", "const c=require('child_process').spawn(process.execPath,[process.argv[1]],{stdio:'inherit'});c.on('exit',x=>process.exit(x??1))", ctx.wrapper]
    : [ctx.wrapper];
  const proc = spawn(process.execPath, args, { env: { ...ctx.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if ("id" in msg) responses.set(msg.id, msg);
  });
  const exited = new Promise((r) => proc.on("exit", r));
  const send = (msg) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  let nextId = 1;
  return {
    proc,
    exited,
    stderr: () => stderr,
    send,
    async request(method, params, id = nextId++) {
      send({ id, method, params });
      return waitFor(() => responses.get(id), 10000);
    },
    async init() {
      await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }, 0);
      send({ method: "notifications/initialized" });
    },
    call(code) {
      return this.request("tools/call", { name: "js", arguments: { code } });
    },
    async close() {
      proc.stdin.end();
      await exited;
    },
  };
}

const sessionOf = (event) => JSON.parse(event.meta["x-codex-turn-metadata"]);

test("answers a request sent before initialize without passing it to cua_repl", async () => {
  const ctx = setup();
  const s = connect(ctx);
  const probe = await s.request("server/discover", {}, "probe-1");
  assert.equal(probe.error.code, -32601);
  await s.init();
  assert.equal((await s.call("1")).result.content[0].text, "ok");
  await s.close();
  assert.ok(!ctx.events().some((e) => e.event === "died"), "the fake server must not have exited");
});

test("adds the Codex turn metadata to every tool call", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  await s.call("1");
  await s.call("2");
  await s.close();
  const calls = ctx.events().filter((e) => e.event === "call" && e.name === "js");
  assert.equal(calls.length, 2);
  const [a, b] = calls.map(sessionOf);
  assert.ok(a.session_id && a.turn_id);
  assert.deepEqual(a, b, "two calls in one turn share session and turn");
});

test("an idle turn ends in cua_repl and in the Computer Use service", async () => {
  const ctx = setup();
  const s = connect(ctx, { env: { PUPPET_IDLE_TURN_MS: "300" } });
  await s.init();
  await s.call("1");
  const { session_id, turn_id } = sessionOf(ctx.events().find((e) => e.event === "call"));
  const ended = await waitFor(() => ctx.events().find((e) => e.event === "call" && e.name === "turn_ended"));
  assert.deepEqual(ended.arguments, { hook_event_name: "Stop", session_id, turn_id });
  const sky = await waitFor(() => ctx.skyPayloads()[0]);
  assert.equal(sky.type, "agent-turn-complete");
  assert.equal(sky["thread-id"], session_id);
  assert.equal(sky["turn-id"], turn_id);
  await s.call("2");
  assert.notEqual(sessionOf(ctx.events().filter((e) => e.event === "call" && e.name === "js").at(-1)).turn_id, turn_id);
  await s.close();
});

test("the Stop hook ends the turn of its own session only", async () => {
  const ctx = setup();
  const mine = connect(ctx);
  const other = connect(ctx, { viaProxy: true });
  await mine.init();
  await other.init();
  await mine.call("mine");
  await other.call("other");
  await waitFor(() => ctx.state().length === 2 && ctx.state().every((e) => e.ppid));
  await new Promise((r) => spawn(process.execPath, [ctx.endTurn], { stdio: "ignore" }).on("exit", r));
  const ended = await waitFor(() => ctx.events().filter((e) => e.name === "turn_ended"));
  await sleep(300);
  const endedSessions = ctx.events().filter((e) => e.name === "turn_ended").map((e) => e.arguments.session_id);
  const mineSession = sessionOf(ctx.events().find((e) => e.arguments?.code === "mine")).session_id;
  assert.ok(ended.length >= 1);
  assert.deepEqual(endedSessions, [mineSession]);
  await mine.close();
  await other.close();
});

test("ends the turn at once when the user presses Esc", async () => {
  const ctx = setup();
  const s = connect(ctx); // default idle delay: only the Esc path can end the turn within the test
  await s.init();
  await s.call("esc");
  const stopped = sessionOf(ctx.events().find((e) => e.arguments?.code === "esc"));
  const ended = await waitFor(() => ctx.events().find((e) => e.name === "turn_ended"));
  assert.equal(ended.arguments.turn_id, stopped.turn_id);
  await waitFor(() => ctx.skyPayloads().length === 1);
  await s.call("next");
  assert.notEqual(sessionOf(ctx.events().find((e) => e.arguments?.code === "next")).turn_id, stopped.turn_id);
  await s.close();
});

test("sends a disabled sandbox profile only when PUPPET_SANDBOX=off", async () => {
  const ctx = setup();
  const on = connect(ctx);
  await on.init();
  await on.call("default");
  await on.close();
  const off = connect(ctx, { env: { PUPPET_SANDBOX: "off" } });
  await off.init();
  await off.call("off");
  await off.close();
  const metaOf = (code) => ctx.events().find((e) => e.arguments?.code === code).meta;
  assert.equal(metaOf("default")["codex/sandbox-state-meta"], undefined);
  const profile = metaOf("off")["codex/sandbox-state-meta"];
  assert.deepEqual(profile.permissionProfile, { type: "disabled" });
  assert.match(profile.sandboxCwd, /^file:\/\//);
});

test("runs the first call of each new kernel after Puppet's additions, in the same cell", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  await s.call("first");
  await s.call("later");
  await sleep(200);
  await s.close();
  const calls = ctx.events().filter((e) => e.event === "call");
  assert.match(calls[0].arguments.kernel, /const cuFind = /);
  assert.match(calls[0].arguments.kernel, /const cuDecorate = /);
  assert.equal(calls[0].arguments.code, "first");
  assert.ok(!calls.slice(1).some((e) => e.arguments?.kernel), "only the first call carries them");
  assert.ok(!calls.some((e) => /^puppet (helpers|check)$/.test(e.arguments?.title ?? "")), "no hidden call needed");

  const off = setup();
  const t = connect(off, { env: { PUPPET_HELPERS: "0" } });
  await t.init();
  await t.call("first");
  await sleep(200);
  await t.close();
  assert.ok(!off.events().some((e) => e.arguments?.kernel || e.arguments?.title === "puppet helpers"));
});

test("adds Puppet's documentation after the docs of a new kernel, once", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  const first = await s.call("let app = await cua.getApp(\"Calculatrice\"); first");
  const texts = first.result.content.map((c) => c.text);
  assert.match(texts[0], /^## Computer Use/);
  assert.match(texts[1], /^## Puppet additions/);
  const later = await s.call("later");
  assert.equal(later.result.content.length, 1, "the documentation comes once");
  await s.close();
});

test("declares Puppet's additions again when the first call failed and took them along", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  const first = await s.call("let app = await cua.getApp(\"com.example.none\"); failfirst");
  assert.equal(first.result.isError, true);
  assert.ok(first.result.content.some((c) => /^## Puppet additions/.test(c.text ?? "")));
  await waitFor(() => ctx.events().find((e) => e.arguments?.title === "puppet check"));
  const helpers = await waitFor(() => ctx.events().find((e) => e.arguments?.title === "puppet helpers"));
  assert.match(helpers.arguments.code, /const cuDecorate = /);
  assert.match(helpers.arguments.code, /try \{ app = await cuAdopt\(app\); \} catch \{\}/, "a binding of the failed call is adopted if it exists");
  await s.call("later");
  await sleep(200);
  await s.close();
  assert.equal(ctx.events().filter((e) => e.arguments?.kernel).length, 1, "later calls are not prefixed again");
});

test("keeps one of identical images in a result", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  const shot = await s.call("twoshots");
  assert.deepEqual(shot.result.content.map((c) => c.type), ["image", "text"]);
  await s.close();
});

test("adds a next step to errors the service reports in plain words", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  const failed = await s.call("invalid");
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content.at(-1).text, /^\[puppet\] .*listApps/);
  const fine = await s.call("1");
  assert.equal(fine.result.content.length, 1, "a successful result gets no hint");
  await s.close();
});

test("turns cua_repl's analytics off only with PUPPET_DISABLE_ANALYTICS=1", async () => {
  const ctx = setup();
  const plain = connect(ctx);
  await plain.init();
  await plain.close();
  const quiet = connect(ctx, { env: { PUPPET_DISABLE_ANALYTICS: "1" } });
  await quiet.init();
  await quiet.close();
  const starts = ctx.events().filter((e) => e.event === "started").map((e) => e.analyticsDisabled);
  assert.deepEqual(starts, [false, true]);
});

test("cuts a long result and saves the whole text to a private file", async () => {
  const ctx = setup();
  const s = connect(ctx, { env: { PUPPET_MAX_OUTPUT_CHARS: "1000", TMPDIR: ctx.dir } });
  await s.init();
  const small = await s.call("big:900");
  assert.equal(small.result.content.length, 1, "a short result is left alone");
  const cut = await s.call("big:5000");
  const [head, note] = cut.result.content;
  assert.equal(head.text.length, 1000);
  const file = /Full text: (\S+?)\. /.exec(note.text)[1];
  assert.equal(fs.readFileSync(file, "utf8").length, 5000);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await s.close();
});

test("restarts cua_repl after a crash and fails the call it lost", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  const lost = await s.call("crash");
  assert.equal(lost.error.code, -32603);
  assert.equal((await s.call("after")).result.content[0].text, "ok");
  await s.close();
  assert.equal(ctx.events().filter((e) => e.event === "initialize").length, 2, "the client's initialize is replayed");
});

test("switches to a newer plugin version at the end of a turn", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  await s.call("before");
  ctx.addPlugin("2.0");
  s.proc.kill("SIGUSR2");
  await waitFor(() => ctx.events().some((e) => e.version === "2.0" && e.event === "initialize"));
  await s.call("after");
  await s.close();
  const after = ctx.events().find((e) => e.arguments?.code === "after");
  assert.equal(after.version, "2.0");
});

test("the stop button refuses further calls until Claude finishes answering", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  await s.call("before");
  s.proc.kill("SIGUSR1");
  await waitFor(() => ctx.state().some((e) => e.stopped === true));
  const refused = await s.call("during");
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /stopped Puppet/);
  assert.ok(!ctx.events().some((e) => e.arguments?.code === "during"), "a refused call must not reach cua_repl");
  s.proc.kill("SIGUSR2");
  await waitFor(() => ctx.state().some((e) => e.stopped === false));
  assert.equal((await s.call("after")).result.content[0].text, "ok");
  await s.close();
});

test("records the browser tab puppet works in for the menu bar app", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  await s.call('let tab = await cua.createBrowserTab("chrome", "https://example.com");');
  await waitFor(() => ctx.state().some((e) => e.tab === "2036936507"));
  await s.close();
});

test("switches to a newer plugin version before the first call of a turn", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  await s.call("before");
  s.proc.kill("SIGUSR2");
  await sleep(300);
  ctx.addPlugin("2.0");
  await s.call("after");
  await s.close();
  const after = ctx.events().find((e) => e.arguments?.code === "after");
  assert.equal(after.version, "2.0");
});

test("refuses to start a server that OpenAI did not sign", { skip: process.platform !== "darwin" }, async () => {
  const ctx = setup();
  const s = connect(ctx, { env: { PUPPET_SKIP_SIGNATURE_CHECK: "0" } });
  const code = await s.exited;
  assert.equal(code, 1);
  assert.match(s.stderr(), /not signed by OpenAI/);
});

test("records each action for the menu bar app", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  s.send({ id: 7, method: "tools/call", params: { name: "js", arguments: { code: 'let app = await cua.getApp("TextEdit");', title: "Ouvrir TextEdit" } } });
  await waitFor(() => ctx.events().some((e) => e.arguments?.title === "Ouvrir TextEdit"));
  await s.call("invalid");
  const lines = await waitFor(() => {
    const all = readLines(path.join(path.dirname(ctx.stateFile), "puppet-activity.jsonl")).map((l) => JSON.parse(l));
    return all.length === 2 && all;
  });
  assert.deepEqual(lines.map((l) => [l.title, l.app, l.ok]), [["Ouvrir TextEdit", "TextEdit", true], ["invalid", "TextEdit", false]]);
  const [entry] = ctx.state();
  assert.equal(entry.busy, false);
  assert.equal(entry.turnActive, true);
  assert.equal(entry.action, "invalid");
  assert.equal(entry.client, "test");
  assert.equal(entry.cwd, process.cwd());
  await s.close();
});

test("saves a picture of the app after each action for the menu bar app", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  s.send({ id: 9, method: "tools/call", params: { name: "js", arguments: { code: 'let app = await cua.getApp("TextEdit");' } } });
  const shot = await waitFor(() => ctx.events().find((e) => e.arguments?.title === "puppet snapshot"));
  assert.match(shot.arguments.code, /await app\.getScreenshot\(\{ emit: false \}\)/);
  const entry = await waitFor(() => ctx.state().find((e) => e.snapshot));
  const file = path.join(path.dirname(ctx.stateFile), entry.snapshot);
  assert.equal(fs.readFileSync(file, "utf8"), "fake-jpeg");
  await s.close();
  assert.ok(!fs.existsSync(file), "removed when the session ends");

  const off = setup();
  const t = connect(off, { env: { PUPPET_SNAPSHOTS: "0" } });
  await t.init();
  await t.request("tools/call", { name: "js", arguments: { code: 'let app = await cua.getApp("TextEdit");' } });
  await sleep(200);
  await t.close();
  assert.ok(!off.events().some((e) => e.arguments?.title === "puppet snapshot"));
});

test("follows a browser tab claimed from the user", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  await s.request("tools/call", { name: "js", arguments: { code: 'let browser = await cua.getBrowser({ id: "chrome" });' } });
  await s.request("tools/call", { name: "js", arguments: { code: 'let tab = await browser.user.claimTab("42");' } });
  const shot = await waitFor(() => ctx.events().filter((e) => e.arguments?.title === "puppet snapshot").find((e) => /tab\.getScreenshot/.test(e.arguments.code)));
  assert.ok(shot);
  assert.equal((await waitFor(() => ctx.state().find((e) => e.app))).app, "browser");
  await s.close();
});

test("keeps the state file whole when many wrappers start at once", async () => {
  const ctx = setup();
  const sessions = Array.from({ length: 8 }, () => connect(ctx));
  await Promise.all(sessions.map((s) => s.init()));
  assert.equal(ctx.state().length, 8);
  await Promise.all(sessions.map((s) => s.close()));
  assert.equal(ctx.state().length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(ctx.stateFile)).sort(), ["puppet-end-turn.mjs", "puppet-server.mjs", "puppet.state.json"]);
});

test("apps listed in puppet-approvals.json are allowed without a dialog", async () => {
  const ctx = setup();
  const approvals = path.join(path.dirname(ctx.wrapper), "puppet-approvals.json");
  fs.writeFileSync(approvals, JSON.stringify({ apps: ["Notes"] }));
  const s = connect(ctx, { env: { PUPPET_NATIVE_PROMPTS: "1" } });
  await s.init();
  const answer = await s.call('ask:Allow Computer Use to use "Notes"?');
  assert.deepEqual(JSON.parse(answer.result.content[0].text), { action: "accept", content: {}, _meta: { persist: "session" } });
  fs.writeFileSync(approvals, JSON.stringify({ allApps: true }));
  const any = await s.call('ask:Allow Computer Use to use "Calendar"?');
  assert.equal(JSON.parse(any.result.content[0].text).action, "accept");
  await s.close();
});

test("the hint for an app without a window ignores the documentation printed with it", async () => {
  const ctx = setup();
  const s = connect(ctx);
  await s.init();
  const failed = await s.call("nowindow");
  assert.match(failed.result.content.at(-1).text, /^\[puppet\] The app has no window/);
  await s.close();
});
