// Puppet additions to Codex's `cua` API, declared by puppet-server.mjs in each new kernel, right
// after the call that printed the documentation. This file is the body of one `js` cell: only
// top-level declarations carry to later calls, so everything here is a top-level `const`.
//
// The `cua` object, the app objects and the tab objects come from OpenAI's code. They are plain
// objects whose methods are own, writable properties, so Puppet wraps them in place:
// - selectors ({ id }, { text, role }, { name: /re/ }) wherever an element index is accepted;
// - a clear error for a stale element index. In an app, a stale index otherwise clicks whatever
//   element now has that number, or fails with "-10005: N is an invalid element ID";
// - getAXState({ full: true }) and, in a tab, getAXState({ fullUrls: true });
// - typeText that focuses the element, checks that the text arrived, and can press Enter;
// - getApp by the displayName that getState() and listApps() show, accents and case aside;
// - tab.goto(url, { waitUntil }), waitFor, waitForIdle and extractLinks;
// - what a click at coordinates hit.
// Every original signature keeps working.

const cuLines = (text, pattern = "", limit = 30, width = 240) => {
  const re = __cuIsRe(pattern) ? pattern : new RegExp(pattern, "i");
  return String(text).split("\n").filter((l) => re.test(l)).slice(0, limit).map((l) => l.slice(0, width)).join("\n");
};
const cuFind = async (target, pattern, limit = 30) =>
  cuLines(await target.getAXState({ emit: false, disableDiffing: true }), pattern, limit);
const cuKey = (combo) => String(combo).split("+").map((k) => ({
  cmd: "super", command: "super", "⌘": "super", opt: "alt", option: "alt", "⌥": "alt",
  control: "ctrl", "⌃": "ctrl", enter: "Return", return: "Return", esc: "Escape", escape: "Escape",
})[k.trim().toLowerCase()] ?? k.trim()).join("+");

// ---------- reading the accessibility tree ----------

// Fields the trees print after the element's role and name: "12 bouton Description: 7, ID: Seven",
// "478 text field (settable) Value: chandail, ID: search-input".
const __cuFieldRe = /(?:^|,\s*|\s)(Description|Value|Help|ID|Secondary Actions|URL|Placeholder|Title|Label|Text): /g;

// One element per numbered line; header lines ("Window: …", "Browser tab: …") are left out. In a
// diff, a line starts with ~ (changed) or + (added) before its indentation.
const cuParse = (text) => {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^[+~-]?([\t ]*)(\d+)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const body = m[3].trim();
    const marks = [...body.matchAll(__cuFieldRe)];
    const head = (marks.length ? body.slice(0, marks[0].index) : body).trim();
    const fields = {};
    marks.forEach((mk, i) => {
      const start = mk.index + mk[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
      fields[mk[1]] = body.slice(start, end).replace(/,\s*$/, "").trim();
    });
    out.push({ index: Number(m[2]), depth: m[1].length, body, head, fields });
  }
  return out;
};

const __cuIsRe = (x) => Object.prototype.toString.call(x) === "[object RegExp]";
const __cuNorm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const __cuEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Role names as the trees print them, in English and in French (the macOS tree uses the system
// language). A role not listed here is matched as written.
const __cuRoles = {
  button: ["button", "bouton", "pop up button", "menu button", "bouton de menu", "bouton de menu local"],
  "text field": ["text field", "textbox", "text box", "search field", "searchbox", "search box", "combobox", "combo box", "text area", "textarea", "champ de texte", "champ de recherche", "zone de texte", "champ de saisie", "zone de liste modifiable"],
  link: ["link", "lien"],
  checkbox: ["checkbox", "check box", "case à cocher", "case a cocher"],
  "radio button": ["radio button", "radio", "bouton radio"],
  "menu item": ["menu item", "menuitem", "élément de menu", "element de menu", "article de menu"],
  menu: ["menu"],
  tab: ["tab", "onglet"],
  heading: ["heading", "titre", "en-tête"],
  image: ["image", "img"],
  "static text": ["static text", "statictext", "texte statique", "texte"],
  slider: ["slider", "curseur"],
  list: ["list", "liste"],
  row: ["row", "ligne"],
  cell: ["cell", "cellule"],
  group: ["group", "groupe"],
  window: ["window", "fenêtre", "fenetre"],
};
const __cuRoleAlias = { textfield: "text field", input: "text field", searchfield: "text field", "search field": "text field", textbox: "text field", btn: "button", a: "link", menuitem: "menu item" };

const __cuRoleWords = (role) => {
  const key = __cuNorm(role);
  const canonical = __cuRoleAlias[key] ?? key;
  return (__cuRoles[canonical] ?? [role]).map(__cuNorm).sort((a, b) => b.length - a.length);
};

const __cuHasRole = (el, role) => {
  const head = __cuNorm(el.head);
  return __cuRoleWords(role).some((w) => head === w || new RegExp(`^${__cuEsc(w)}(?=[\\s"'(:,]|$)`).test(head));
};

// The strings an element is known by: its name after the role, its quoted text, and its fields.
const __cuNames = (el) => {
  const names = [];
  const head = el.head.replace(/\([^)]*\)/g, " ").trim();
  for (const q of head.matchAll(/"([^"]+)"|“([^”]+)”/g)) names.push(q[1] ?? q[2]);
  const role = Object.values(__cuRoles).flat().map(__cuNorm).sort((a, b) => b.length - a.length).find((w) => __cuNorm(head).startsWith(w + " "));
  names.push(role ? head.slice(role.length).trim() : head.split(/\s+/).slice(1).join(" "));
  for (const k of ["Description", "Title", "Label", "Value", "Placeholder", "Text", "ID"]) if (el.fields[k]) names.push(el.fields[k]);
  return names.map((n) => n.replace(/^["“]|["”]$/g, "").trim()).filter(Boolean);
};

// How well a pattern names an element: 3 equal, 2 whole words, 1 anywhere in the line, 0 not at all.
const __cuRank = (el, pattern, namesOnly) => {
  const names = __cuNames(el);
  if (__cuIsRe(pattern)) {
    if (names.some((n) => pattern.test(n))) return 2;
    return !namesOnly && pattern.test(el.body) ? 1 : 0;
  }
  const p = __cuNorm(pattern);
  if (!p) return 0;
  if (names.some((n) => __cuNorm(n) === p)) return 3;
  const words = new RegExp(`(^|[^\\p{L}\\p{N}])${__cuEsc(p)}($|[^\\p{L}\\p{N}])`, "u");
  if (names.some((n) => words.test(__cuNorm(n)))) return 2;
  return !namesOnly && __cuNorm(el.body).includes(p) ? 1 : 0;
};

const __cuIsSelector = (t) => typeof t === "string" || (t != null && typeof t === "object" && !Array.isArray(t) && !__cuIsRe(t));

// An ID without the state some apps append to it ("StandardInputView;value:98").
const __cuId = (id) => String(id ?? "").split(";")[0];

// The elements a selector matches, best first. Keys: id, text (anywhere in the line), name (its
// name, description or value only), role, value, nth. A string is an ID, or else a text.
// An ID that matches nothing exactly falls back to an ID that contains it or that it contains, when
// only one does (the Calculator's AllClear button becomes Clear once a number is shown).
const cuMatch = (elements, selector) => {
  const sel = typeof selector === "string" ? { idOrText: selector } : selector;
  const scored = [];
  for (const el of elements) {
    if (sel.role && !__cuHasRole(el, sel.role)) continue;
    if (sel.id != null) {
      const id = el.fields.ID;
      if (!id || (__cuIsRe(sel.id) ? !sel.id.test(id) : __cuId(id) !== String(sel.id) && id !== String(sel.id))) continue;
    }
    if (sel.value != null && !__cuNorm(el.fields.Value).includes(__cuNorm(sel.value))) continue;
    let rank = 3;
    if (sel.idOrText != null) rank = __cuId(el.fields.ID) === sel.idOrText ? 4 : __cuRank(el, sel.idOrText, false);
    if (sel.text != null) rank = Math.min(rank, __cuRank(el, sel.text, false));
    if (sel.name != null) rank = Math.min(rank, __cuRank(el, sel.name, true));
    if (rank > 0) scored.push({ el, rank });
  }
  if (!scored.length && typeof sel.id === "string") {
    const want = __cuNorm(sel.id);
    const near = elements.filter((el) => {
      const id = __cuNorm(__cuId(el.fields.ID));
      return id.length > 2 && (id.includes(want) || want.includes(id)) && (!sel.role || __cuHasRole(el, sel.role));
    });
    if (near.length === 1) return [{ ...near[0], rank: 1, note: `no ID ${JSON.stringify(sel.id)}; used ID ${JSON.stringify(near[0].fields.ID)}` }];
  }
  return scored.sort((a, b) => b.rank - a.rank).map((s) => ({ ...s.el, rank: s.rank }));
};

const __cuDescribe = (sel) =>
  typeof sel === "string" ? JSON.stringify(sel) : `{ ${Object.entries(sel).map(([k, v]) => `${k}: ${__cuIsRe(v) ? v : JSON.stringify(v)}`).join(", ")} }`;
const __cuList = (els, max = 12) => els.slice(0, max).map((e) => `  ${e.index} ${e.body.slice(0, 160)}`).join("\n") + (els.length > max ? `\n  … ${els.length - max} more` : "");

// ---------- per-target state ----------

const __cuOrig = Symbol.for("puppet.original");
// target -> { n: snapshots read, elements: Map(index -> element) as last seen, focused: index }
const __cuState = new WeakMap();

const __cuNote = (target, text, full) => {
  const s = __cuState.get(target) ?? { n: 0, elements: new Map(), focused: null };
  s.n += 1;
  const els = cuParse(text);
  if (full) s.elements = new Map(els.map((e) => [e.index, e]));
  else for (const e of els) s.elements.set(e.index, e);
  const focus = /The focused UI element is (\d+)/.exec(String(text));
  s.focused = focus ? Number(focus[1]) : full ? null : s.focused;
  __cuState.set(target, s);
  return els;
};

// A full tree, read without printing it. Reading alone does not renumber elements; the interface
// changing does.
const __cuRead = async (target) => {
  const text = await target[__cuOrig].getAXState({ emit: false, disableDiffing: true });
  const elements = __cuNote(target, text, true);
  return { text, elements, focused: __cuState.get(target).focused };
};

const __cuIsTab = (t) => typeof t?.goto === "function" || (t?.playwright != null && typeof t.playwright === "object");
const __cuWait = (ms) => new Promise((r) => setTimeout(r, ms));
const __cuRoleGroups = { click: ["button", "link", "checkbox", "radio button", "menu item", "tab"], type: ["text field"] };

// The element a selector names in a fresh tree. With no match yet, it reads again until
// `timeout` (a panel may still be opening). With several equally good matches it prefers the
// focused one, then buttons and links (to click) or text fields (to type); otherwise it fails and
// lists them, so the caller can add a role, an id or { nth }.
const cuResolve = async (target, selector, purpose = "click") => {
  if (Number.isInteger(selector)) return { index: selector, element: __cuState.get(target)?.elements.get(selector) ?? null };
  if (selector && typeof selector === "object" && Number.isInteger(selector.index)) return { index: selector.index, element: null };
  const timeout = (typeof selector === "object" && selector.timeout) ?? 3000;
  const deadline = Date.now() + timeout;
  let read;
  let found;
  for (;;) {
    read = await __cuRead(target);
    found = cuMatch(read.elements, selector);
    if (found.length || Date.now() >= deadline) break;
    await __cuWait(300);
  }
  const nth = typeof selector === "object" ? selector.nth : undefined;
  if (found.length) found = found.filter((e) => e.rank === found[0].rank);
  if (found.length > 1 && nth == null) {
    const focused = found.filter((e) => e.index === read.focused);
    const roles = __cuRoleGroups[purpose] ?? [];
    const preferred = found.filter((e) => roles.some((r) => __cuHasRole(e, r)));
    if (focused.length === 1) found = focused;
    else if (preferred.length) found = preferred;
  }
  if (found.length === 1 || (found.length > 1 && nth != null)) {
    const el = found[Math.min(nth ?? 0, found.length - 1)];
    return { index: el.index, element: el, ...(el.note ? { note: el.note } : {}) };
  }
  const n = __cuState.get(target)?.n;
  if (!found.length) {
    const key = typeof selector === "string" ? selector : selector.text ?? selector.name ?? selector.id ?? "";
    const words = __cuNorm(__cuIsRe(key) ? key.source : key).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    const near = read.elements.filter((e) => (selector.role && __cuHasRole(e, selector.role)) || words.some((w) => __cuNorm(e.body).includes(w)));
    throw new Error(
      `[puppet] No element matches ${__cuDescribe(selector)} in the current snapshot (#${n}, ${read.elements.length} elements).` +
        (near.length ? ` Close candidates:\n${__cuList(near)}` : " Read the tree with getAXState({ full: true }) to see what is there."),
    );
  }
  throw new Error(
    `[puppet] ${found.length} elements match ${__cuDescribe(selector)} in the current snapshot (#${n}). ` +
      `Add a role, an id or { nth: 0 } to pick one:\n${__cuList(found)}`,
  );
};

// All the elements a selector matches in a fresh tree, without acting.
const cuQuery = async (target, selector) => cuMatch((await __cuRead(target)).elements, selector);

// Whether two lines are the same element: same ID, or same role, name and description.
const __cuSame = (a, b) =>
  a.fields.ID || b.fields.ID
    ? __cuId(a.fields.ID) === __cuId(b.fields.ID)
    : a.head.replace(/\([^)]*\)/g, "") === b.head.replace(/\([^)]*\)/g, "") && (a.fields.Description ?? "") === (b.fields.Description ?? "");

const __cuStaleError = (target, index, before, now) => {
  const n = __cuState.get(target)?.n ?? 0;
  const where = before
    ? now.length === 1
      ? ` Element ${index} was "${before.body.slice(0, 100)}"; it is now index ${now[0].index}.`
      : ` Element ${index} was "${before.body.slice(0, 100)}"${now.length ? "" : "; it is no longer there"}.`
    : "";
  const hint = before?.fields.ID ? `click({ id: ${JSON.stringify(__cuId(before.fields.ID))} })` : `click({ text: "…", role: "button" })`;
  return new Error(
    `[puppet] Stale element index ${index}: the tree was renumbered since it was read (current snapshot #${n}).${where} ` +
      `Read it again with getAXState({ full: true }), or target the element by selector, for example ${hint}.`,
  );
};

// In a native app, a stale index does not fail: it acts on whatever element now has that number.
// So before an action by index, read the tree again and check that the index still names the
// element last seen there. { check: false } in the action's options skips this.
const __cuCheck = async (target, index) => {
  const before = __cuState.get(target)?.elements.get(index);
  if (!before) return;
  const { elements } = await __cuRead(target);
  const current = elements.find((e) => e.index === index);
  if (current && __cuSame(before, current)) return;
  throw __cuStaleError(target, index, before, elements.filter((e) => __cuSame(before, e)));
};

const __cuStaleRe = /(\d+) is an invalid element ID|element ID is no longer valid|is stale or missing|invalid element (?:ID|index)/i;

// The service's own stale-index errors ("-10005: N is an invalid element ID" in an app,
// "Accessibility element N is stale or missing" in a tab), turned into what to do next.
const __cuStale = async (target, error, index) => {
  if (!__cuStaleRe.test(String(error?.message ?? error))) return error;
  const before = Number.isInteger(index) ? __cuState.get(target)?.elements.get(index) : null;
  let now = [];
  try {
    const { elements } = await __cuRead(target);
    if (before) now = elements.filter((e) => __cuSame(before, e));
  } catch {}
  return __cuStaleError(target, index, before, now);
};

// ---------- decorating apps and tabs ----------

// Returns the decorated object: the app itself, or for a tab a new object that inherits from it.
// A tab reaches the kernel through cua_repl's membrane, which ignores an assignment to one of the
// tab's own methods (tab.click = … leaves the original in place), while a new object can override
// them and still reads everything else from the tab.
const cuDecorate = (input) => {
  if (!input || typeof input !== "object" || input[__cuOrig] || typeof input.click !== "function") return input;
  const target = __cuIsTab(input) ? Object.create(input) : input;
  const orig = {};
  for (const k of ["getAXState", "click", "typeText", "setValue", "pressKey", "selectText", "performSecondaryAction", "goto"]) {
    if (typeof input[k] === "function") orig[k] = input[k].bind(input);
  }
  Object.defineProperty(target, __cuOrig, { value: orig, enumerable: false });
  const tab = __cuIsTab(target);
  // An action on an element index: checked first in an app, its stale-index error explained.
  const act = async (index, opts, work) => {
    if (!tab && Number.isInteger(index) && opts?.check !== false) await __cuCheck(target, index);
    try {
      return await work();
    } catch (e) {
      throw await __cuStale(target, e, index);
    }
  };
  const resolve = async (where, purpose) => (__cuIsSelector(where) ? cuResolve(target, where, purpose) : { index: where, element: __cuState.get(target)?.elements.get(where) ?? null });
  const strip = (opts) => {
    if (!opts || typeof opts !== "object") return opts;
    const { check, settle, ...rest } = opts;
    return Object.keys(rest).length ? rest : undefined;
  };

  target.getAXState = async (opts = {}) => {
    const full = opts?.full === true || opts?.disableDiffing === true;
    const { full: _full, fullUrls, ...rest } = opts ?? {};
    const pass = { ...rest, ...(full ? { disableDiffing: true } : {}) };
    if (!(tab && fullUrls)) {
      const text = await orig.getAXState(pass);
      __cuNote(target, text, full);
      return text;
    }
    let text = await orig.getAXState({ ...pass, emit: false });
    __cuNote(target, text, full);
    text = await __cuFullUrls(target, text);
    if (opts.emit !== false) nodeRepl.write(text);
    return text;
  };

  // In a tab, a click often opens a panel or starts a navigation: wait until the tree stops
  // changing (at most 2 s) so the next selector sees the new page. { settle: false } skips it.
  const settle = async (opts) => {
    if (tab && opts?.settle !== false) await __cuSettle(target, 2000);
  };

  target.click = async (where, opts) => {
    if (Array.isArray(where)) {
      await orig.click(where, strip(opts));
      const hit = await __cuHit(target, where, tab);
      await settle(opts);
      return { clicked: where, ...hit };
    }
    const { index, element, note } = await resolve(where, "click");
    await act(index, __cuIsSelector(where) ? { check: false } : opts, () => orig.click(index, strip(opts)));
    await settle(opts);
    return { clicked: index, element: element?.body ?? null, ...(note ? { note } : {}) };
  };

  target.setValue = async (where, value, opts) => {
    const { index } = await resolve(where, "type");
    await act(index, __cuIsSelector(where) ? { check: false } : opts, () => orig.setValue(index, value));
    return { set: index, value };
  };

  for (const k of ["selectText", "performSecondaryAction"]) {
    if (!orig[k]) continue;
    target[k] = async (where, ...args) => {
      const { index } = await resolve(where, "click");
      return act(index, __cuIsSelector(where) ? { check: false } : undefined, () => orig[k](index, ...args));
    };
  }

  if (tab && orig.pressKey) {
    // pressKey(key) alone presses at the current focus, like pressKey(null, key).
    target.pressKey = async (...args) => {
      if (typeof args[0] === "string" && (args.length === 1 || typeof args[1] !== "string")) return orig.pressKey(null, ...args);
      const [where, ...rest] = args;
      if (where == null) return orig.pressKey(null, ...rest);
      const { index } = await resolve(where, "click");
      return act(index, undefined, () => orig.pressKey(index, ...rest));
    };
  }

  target.typeText = async (...args) => __cuType(target, orig, tab, args, act, resolve);

  if (tab) {
    if (orig.goto) {
      // goto(url, { waitUntil: "load" | "domcontentloaded" | "networkidle", timeout }) in the same tab.
      target.goto = async (url, opts = {}) => {
        const { waitUntil, timeout, ...rest } = opts ?? {};
        await (Object.keys(rest).length ? orig.goto(url, rest) : orig.goto(url));
        if (waitUntil && typeof target.playwright?.waitForLoadState === "function") {
          try {
            await target.playwright.waitForLoadState(waitUntil, timeout ? { timeout } : undefined);
          } catch {}
        }
        return { url: typeof target.url === "function" ? await target.url() : url };
      };
    }
    target.extractLinks = (opts) => __cuLinks(target, opts);
  }
  target.waitFor = (cond, opts) => __cuWaitFor(target, cond, opts);
  target.waitForIdle = (opts) => __cuIdle(target, tab, opts);
  return target;
};

// typeText signatures:
//   app: typeText(text) at the current focus, as before; typeText(target, text, opts).
//   tab: typeText(index | null, text), as before; typeText(text) at the current focus;
//        typeText(target, text, opts).
// With a target (index or selector), the element is clicked to focus it, the text is typed at the
// focus, and the tree is read again: if no field shows the text, a tab tries setValue on it, and
// otherwise the call fails. opts: { submit: true } presses Enter after typing; { verify: false }
// skips the check.
const __cuType = async (target, orig, tab, args, act, resolve) => {
  const [a, b, c] = args;
  let where;
  let text;
  let opts;
  if (typeof a === "string" && (b === undefined || (b !== null && typeof b === "object" && !Array.isArray(b)))) [text, opts] = [a, b];
  else if (typeof a === "string" && Number.isInteger(b)) [text, where, opts] = [a, b, c]; // the Linux-only typeText(text, index)
  else [where, text, opts] = [a, b, c];
  opts ??= {};
  text = String(text ?? "");
  const atFocus = () => (tab ? orig.typeText(null, text) : orig.typeText(text));
  const enter = () => (tab ? orig.pressKey(null, "Enter") : orig.pressKey("Return"));
  if (where == null) {
    await atFocus();
    if (opts.submit) await enter();
    return { typed: text, target: null, ...(opts.submit ? { submitted: true } : {}) };
  }
  const { index, element } = await resolve(where, "type");
  await act(index, __cuIsSelector(where) ? { check: false } : opts, () => orig.click(index));
  await atFocus();
  let ok = opts.verify === false || (await __cuShows(target, text));
  if (!ok && tab && orig.setValue) {
    try {
      const again = element ? (await __cuRead(target)).elements.filter((e) => __cuSame(element, e)) : [];
      await orig.setValue(again.length === 1 ? again[0].index : index, text);
      ok = await __cuShows(target, text);
    } catch {}
  }
  if (!ok) {
    throw new Error(
      `[puppet] Typed ${JSON.stringify(text.slice(0, 60))} into element ${index}, but no field shows it. ` +
        "Click the field, check the focus with getAXState({ full: true }), then typeText(null, text) in a tab or typeText(text) in an app.",
    );
  }
  if (opts.submit) await enter();
  return { typed: text, target: index, element: element?.body ?? null, ...(opts.submit ? { submitted: true } : {}) };
};

// Whether a field in a fresh tree shows the text (its value, or a text field's name), retried for
// about a second and a half while the page catches up.
const __cuShows = async (target, text) => {
  const want = __cuNorm(text).slice(0, 40);
  for (let i = 0; i < 5; i++) {
    await __cuWait(i ? 300 : 120);
    const { elements } = await __cuRead(target);
    if (elements.some((e) => __cuNorm(e.fields.Value).includes(want) || (__cuHasRole(e, "text field") && __cuNorm(e.body).includes(want)))) return true;
  }
  return false;
};

// Read the tree until two reads 250 ms apart are the same, or `max` ms have passed.
const __cuSettle = async (target, max) => {
  const t0 = Date.now();
  let previous = (await __cuRead(target)).text;
  while (Date.now() - t0 < max) {
    await __cuWait(250);
    const { text } = await __cuRead(target);
    if (text === previous) return true;
    previous = text;
  }
  return false;
};

// What a click at coordinates landed on. In a tab, the page says which element is there (tab
// coordinates are CSS pixels, as in its screenshots). An app has no such query, so the result
// lists what changed in its tree instead.
const __cuHit = async (target, [x, y], tab) => {
  if (tab && typeof target.playwright?.evaluate === "function") {
    try {
      const hit = await target.playwright.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return null;
          const t = el.closest("a,button,input,select,textarea,label,summary,[role],[onclick]") ?? el;
          const text = (t.getAttribute("aria-label") || t.innerText || t.value || t.title || t.alt || "").replace(/\s+/g, " ").trim().slice(0, 120);
          return { tag: t.tagName.toLowerCase(), role: t.getAttribute("role"), text, href: t.href || null, id: t.id || null };
        },
        { x, y },
      );
      return { hit };
    } catch (e) {
      return { hit: null, hitError: String(e?.message ?? e).slice(0, 200) };
    }
  }
  try {
    await __cuWait(150);
    const diff = await target[__cuOrig].getAXState({ emit: false });
    __cuNote(target, diff, false);
    return { hit: null, changes: String(diff).split("\n").slice(0, 15).map((l) => l.slice(0, 160)).join("\n") };
  } catch {
    return { hit: null };
  }
};

// Truncated URLs in a tab's tree ("simons.ca/fr/vetements-femme/les-incontourn…") replaced by the
// full href when exactly one link on the page starts that way.
const __cuFullUrls = async (target, text) => {
  let hrefs = [];
  try {
    hrefs = await target.playwright.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
  } catch {
    return text;
  }
  const bare = (u) => u.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "");
  const unique = [...new Set(hrefs)];
  return text.replace(/((?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+\/[^\s,"'…]*)…/g, (all, prefix) => {
    const p = bare(prefix);
    const found = [...new Set(unique.filter((h) => bare(h).startsWith(p)))];
    return found.length === 1 ? found[0] : all;
  });
};

// Clean { text, href } for the links of a tab, one per href, read from the page itself (full URLs,
// visible text without markup). opts: { match: /re/ or "text" (tested on text and href),
// limit: 500, strip: [/extra noise/] }.
const __cuNoise = [/aper[cç]u rapide/gi, /d[ée]tails complets/gi, /quick ?view/gi, /full details/gi, /ajouter au panier/gi, /add to (?:cart|bag)/gi, /(?:^|\s)\+\d+(?=\s|$)/g];
const __cuLinks = async (target, opts = {}) => {
  const raw = await target.playwright.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map((a) => ({
      href: a.href,
      text: a.innerText || a.getAttribute("aria-label") || a.title || (a.querySelector("img[alt]") || {}).alt || "",
    })),
  );
  const strip = [...__cuNoise, ...(opts.strip ?? [])];
  const clean = (t) => {
    let s = String(t).replace(/<[^>]*>/g, " ");
    for (const re of strip) s = s.replace(re, " ");
    s = s.replace(/\b(\w+)(?:\s+\1\b){2,}/giu, " "); // "swatch swatch swatch"
    s = s.replace(/\bswatch\b/gi, " ");
    return s.replace(/\s+/g, " ").trim();
  };
  const byHref = new Map();
  for (const { href, text } of raw) {
    if (!href || /^(javascript:|mailto:|tel:)/i.test(href)) continue;
    const t = clean(text);
    const parts = byHref.get(href) ?? [];
    for (const piece of t ? [t] : []) if (!parts.some((p) => p.includes(piece))) parts.push(piece);
    byHref.set(href, parts);
  }
  let links = [...byHref].map(([href, parts]) => ({ text: parts.join(" · "), href })).filter((l) => l.text);
  if (opts.match != null) {
    const re = __cuIsRe(opts.match) ? opts.match : new RegExp(__cuEsc(String(opts.match)), "i");
    links = links.filter((l) => re.test(l.text) || re.test(l.href));
  }
  return links.slice(0, opts.limit ?? 500);
};

// Wait until a condition holds, reading the tree without printing it.
// cond: { text } | { role, name } | { id } | any selector | { urlIncludes } (tab), or a function
// (async () => boolean). opts: { timeout: 10000, interval: 400 }. Returns the first match.
const __cuWaitFor = async (target, cond, opts = {}) => {
  const timeout = opts.timeout ?? 10000;
  const interval = opts.interval ?? 400;
  const deadline = Date.now() + timeout;
  let last = "";
  for (;;) {
    try {
      if (typeof cond === "function") {
        if (await cond()) return true;
      } else if (cond?.urlIncludes != null) {
        const url = await target.url();
        last = url;
        if (String(url).includes(cond.urlIncludes)) return { url };
      } else {
        const { elements } = await __cuRead(target);
        const found = cuMatch(elements, cond);
        if (found.length) return { index: found[0].index, element: found[0].body, count: found.length };
      }
    } catch (e) {
      last = String(e?.message ?? e);
    }
    if (Date.now() >= deadline) {
      throw new Error(`[puppet] waitFor ${typeof cond === "function" ? "function" : __cuDescribe(cond)} timed out after ${timeout} ms${last ? ` (last: ${last.slice(0, 200)})` : ""}.`);
    }
    await __cuWait(interval);
  }
};

// Wait until the page has loaded (tab) and the tree stops changing between two reads.
// opts: { timeout: 10000, quiet: 600 }.
const __cuIdle = async (target, tab, opts = {}) => {
  const timeout = opts.timeout ?? 10000;
  const quiet = opts.quiet ?? 600;
  const t0 = Date.now();
  if (tab && typeof target.playwright?.waitForLoadState === "function") {
    try {
      await target.playwright.waitForLoadState("load", { timeout });
    } catch {}
  }
  let previous = null;
  while (Date.now() - t0 < timeout) {
    const { text } = await __cuRead(target);
    if (text === previous) return { idle: true, ms: Date.now() - t0 };
    previous = text;
    await __cuWait(quiet);
  }
  return { idle: false, ms: Date.now() - t0 };
};

// ---------- cua: getApp by displayName, and every app or tab decorated ----------

const __cuAppId = async (name) => {
  let apps = [];
  try {
    const list = await cua.listApps({ emit: false });
    apps = Array.isArray(list) ? list : list?.apps ?? [];
  } catch {}
  if (!apps.length) {
    try {
      apps = (await cua.getState({ emit: false }))?.apps ?? [];
    } catch {}
  }
  const want = __cuNorm(String(name).replace(/\.app$/i, ""));
  const named = (a) => [a.displayName, a.name, a.id].filter(Boolean).map(__cuNorm);
  let hits = apps.filter((a) => named(a).includes(want));
  if (!hits.length) hits = apps.filter((a) => named(a).some((n) => n.startsWith(want)));
  const ids = [...new Set(hits.map((a) => a.id).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
};

const __cuWrapCua = () => {
  if (typeof cua !== "object" || cua == null || cua[__cuOrig]) return;
  const orig = {};
  Object.defineProperty(cua, __cuOrig, { value: orig, enumerable: false });
  if (typeof cua.getApp === "function") {
    orig.getApp = cua.getApp;
    // The app's tree printed by getApp is read again, silently, so that later actions by index can
    // be checked against it.
    const seed = async (app) => {
      cuDecorate(app);
      try {
        if (app?.[__cuOrig]) await __cuRead(app);
      } catch {}
      return app;
    };
    cua.getApp = async function (name, ...rest) {
      try {
        return await seed(await orig.getApp.call(this, name, ...rest));
      } catch (e) {
        if (typeof name !== "string" || !/Invalid app/i.test(String(e?.message))) throw e;
        const id = await __cuAppId(name);
        if (!id || id === name) throw e;
        return seed(await orig.getApp.call(this, id, ...rest));
      }
    };
  }
  for (const k of ["getTab", "createBrowserTab"]) {
    if (typeof cua[k] !== "function") continue;
    orig[k] = cua[k];
    cua[k] = async function (...args) {
      return cuDecorate(await orig[k].apply(this, args));
    };
  }
  if (typeof cua.getBrowser === "function") {
    orig.getBrowser = cua.getBrowser;
    cua.getBrowser = async function (...args) {
      const browser = await orig.getBrowser.apply(this, args);
      for (const holder of [browser?.tabs, browser?.user]) {
        if (!holder || holder[__cuOrig]) continue;
        Object.defineProperty(holder, __cuOrig, { value: true, enumerable: false });
        for (const m of ["get", "new", "selected", "claimTab"]) {
          const f = holder[m];
          if (typeof f !== "function") continue;
          try {
            holder[m] = async (...a) => cuDecorate(await f.apply(holder, a));
          } catch {}
        }
      }
      return browser;
    };
  }
};
__cuWrapCua();

// An app or tab bound before this file was loaded (the first call of a kernel), decorated: an app
// in place, with its tree read once so that actions by index can be checked; a tab as the new
// object cuDecorate returns, which the server assigns back to the variable.
const cuAdopt = async (input) => {
  const target = cuDecorate(input);
  if (target?.[__cuOrig] && !__cuIsTab(target) && !__cuState.has(target)) {
    try {
      await __cuRead(target);
    } catch {}
  }
  return target;
};
