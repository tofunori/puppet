#!/usr/bin/env node
// Claude Code Stop hook: tells this session's puppet wrappers (SIGUSR2) to end their turn now,
// so Chrome tabs are released and the Computer Use cursor disappears as soon as Claude finishes
// answering. A wrapper belongs to this session when its parent process is one of this hook's
// ancestors (the Claude Code process). Always exits 0 so it never blocks Claude.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "puppet.state.json");

try {
  const entries = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).entries ?? [];
  if (entries.length) {
    const parentOf = new Map(
      execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number)),
    );
    const ancestors = new Set();
    for (let pid = process.ppid; pid > 1 && !ancestors.has(pid); pid = parentOf.get(pid) ?? 0) ancestors.add(pid);
    for (const { pid, ppid } of entries) {
      if (!ancestors.has(ppid)) continue;
      try {
        process.kill(pid, "SIGUSR2");
      } catch {}
    }
  }
} catch {}
