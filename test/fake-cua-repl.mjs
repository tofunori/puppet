#!/usr/bin/env node
// A stand-in for cua_repl, for the wrapper tests. Like the real server it exits on a request that
// arrives before `initialize`. Every event is appended to $FAKE_LOG as one JSON line.
// `js` with code "crash" makes it exit, "esc" answers as the service does after the user pressed
// Esc, "first" (alone or after other statements) answers like the first call of a new kernel,
// "failfirst" fails as a first call does (with the docs of a new kernel),
// "twoshots" answers the same image twice, "nowindow" fails as getApp does for an app
// with no window (with the docs of a new kernel), "invalid" fails as getApp does for an
// unknown app, "big:N" answers N characters, "ask:<message>" sends a Computer Use app prompt with
// that message and answers the client's reply as JSON, code calling getScreenshot answers a small
// image, and any other code answers "ok".

import fs from "node:fs";
import readline from "node:readline";

const version = process.env.FAKE_VERSION ?? "1";
const KERNEL_SEPARATOR = "\n;// ---- end of Puppet's additions; the call's own code follows ----\n";
const log = (event) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ version, ...event }) + "\n");
let initialized = false;
let unparsed = false;
const pending = new Map();

log({ event: "started", analyticsDisabled: process.env.NODE_REPL_DISABLE_ANALYTICS === "1" });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method && pending.has(msg.id)) return pending.get(msg.id)(msg.result);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  if (!initialized && msg.method !== "initialize" && "id" in msg) {
    log({ event: "died", method: msg.method });
    process.exit(1);
  }
  if (msg.method === "initialize") {
    initialized = true;
    log({ event: "initialize" });
    reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version } });
  } else if (msg.method === "tools/list") {
    reply({ tools: ["js", "js_reset", "turn_ended"].map((name) => ({ name, inputSchema: { type: "object" } })) });
  } else if (msg.method === "tools/call") {
    // The first call of a kernel comes after Puppet's additions: answer the call's own code.
    const [kernel, own] = String(msg.params.arguments?.code ?? "").split(KERNEL_SEPARATOR);
    if (own !== undefined) msg.params.arguments = { ...msg.params.arguments, code: own, kernel };
    log({ event: "call", name: msg.params.name, arguments: msg.params.arguments, meta: msg.params._meta });
    if (/typeof cuDecorate/.test(msg.params.arguments?.code ?? "")) {
      // A failed first call took the additions' declarations with it. After one that did not parse,
      // the kernel starts now and prints its documentation here.
      const docs = unparsed ? [{ type: "text", text: "## Computer Use\n\n(documentation of a new kernel)" }] : [];
      unparsed = false;
      return reply({ content: [...docs, { type: "text", text: "undefined" }] });
    }
    if (msg.params.arguments?.code === "let x = ;") {
      // A syntax error: the cell does not run, the kernel does not start, the line counts the prefix.
      unparsed = true;
      const line = (msg.params.arguments.kernel ?? "").split("\n").length + 2;
      return reply({ content: [{ type: "text", text: `[${line}:8-${line}:9]: Unexpected token: ';'` }], isError: true });
    }
    if (msg.params.arguments?.code === "crash") process.exit(3);
    if (msg.params.arguments?.code === "twoshots") {
      // getScreenshot() shows its image, and nodeRepl.emitImage shows it again.
      const image = { type: "image", data: Buffer.from("same-jpeg").toString("base64"), mimeType: "image/jpeg" };
      return reply({ content: [image, { ...image }, { type: "text", text: "done" }] });
    }
    if (/\.getScreenshot\(/.test(msg.params.arguments?.code ?? "")) {
      return reply({ content: [{ type: "image", data: Buffer.from("fake-jpeg").toString("base64"), mimeType: "image/jpeg" }] });
    }
    const ask = /^ask:(.*)$/s.exec(msg.params.arguments?.code ?? "");
    if (ask) {
      const id = `elicit-${msg.id}`;
      pending.set(id, (result) => reply({ content: [{ type: "text", text: JSON.stringify(result) }] }));
      const _meta = { persist: "session", riskLevel: "low", connector_name: "Computer Use" };
      const params = { message: ask[1], requestedSchema: { type: "object", properties: {} }, _meta };
      return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method: "elicitation/create", params }) + "\n");
    }
    if (/createBrowserTab\(/.test(msg.params.arguments?.code ?? "")) {
      return reply({ content: [{ type: "text", text: 'Browser tab: 2036936507, Title: "Example Domain", URL: "https://example.com/".' }] });
    }
    const big = /^big:(\d+)$/.exec(msg.params.arguments?.code ?? "");
    if (big) return reply({ content: [{ type: "text", text: "x".repeat(Number(big[1])) }] });
    if (/(^|; )first$/.test(msg.params.arguments?.code ?? "")) {
      return reply({ content: [{ type: "text", text: "## Computer Use\n\n(documentation of a new kernel)" }] });
    }
    if (msg.params.arguments?.code === "nowindow") {
      const content = [
        { type: "text", text: "Computer Use server error -10005: cgWindowNotFound" },
        { type: "text", text: "## Computer Use\n\nGrant Accessibility and Screen Recording first." },
      ];
      return reply({ content, isError: true });
    }
    if (/(^|; )failfirst$/.test(msg.params.arguments?.code ?? "")) {
      // A first call that fails still prints the documentation of the new kernel.
      const content = [
        { type: "text", text: "Invalid app: Calculatrice" },
        { type: "text", text: "## Computer Use\n\n(documentation of a new kernel)" },
      ];
      return reply({ content, isError: true });
    }
    if (msg.params.arguments?.code === "invalid") {
      return reply({ content: [{ type: "text", text: "Invalid app: com.example.none" }], isError: true });
    }
    if (msg.params.arguments?.code === "esc") {
      // The Computer Use service's answer once the user pressed Esc.
      const text = "This application session has been explicitly stopped by the user for this turn.";
      return reply({ content: [{ type: "text", text }], isError: true });
    }
    reply({ content: [{ type: "text", text: "ok" }] });
  }
});
