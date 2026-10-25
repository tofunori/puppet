// Tests for puppet-kernel.js, the additions Puppet declares in each kernel. The file runs in a vm
// context against fake `cua`, app and tab objects shaped like Codex's: plain objects whose methods
// are own properties, trees printed as "index role name, Field: value" lines.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KERNEL = fs.readFileSync(path.join(REPO, "puppet-kernel.js"), "utf8");

// Values and errors made in the vm context have its own prototypes: compare them as plain data, and
// errors by their message.
const plain = (value) => JSON.parse(JSON.stringify(value));
const rejectsWith = (promise, pattern) => assert.rejects(promise, (e) => (assert.match(e.message, pattern), true));

// Runs the kernel with these globals and returns its declarations.
function kernel(globals) {
  const written = [];
  const context = vm.createContext({
    setTimeout,
    nodeRepl: { write: (t) => written.push(String(t)), emitImage: () => {} },
    ...globals,
  });
  const api = new vm.Script(`${KERNEL}\n;({ cuParse, cuMatch, cuResolve, cuQuery, cuDecorate, cuAdopt, cuFind })`).runInContext(context);
  return { ...api, written };
}

// The Calculator as the macOS tree shows it, in French. Once a number is shown, a "Dernière
// expression" line appears above the display and every index after it moves by one, and AllClear
// becomes Clear: the renumbering that made indices stale.
function calculator() {
  const calc = { display: "0", pending: null, op: null, typedSince: false, clicks: [] };
  const keys = [
    ["Tout effacer", "AllClear"],
    ["7", "Seven"],
    ["9", "Nine"],
    ["6", "Six"],
    ["Multiplier", "Multiply"],
    ["Égal", "Equals"],
  ];
  const lines = () => {
    const out = ['Window: "Calculatrice", App: Calculatrice.', "0 fenêtre standard Calculatrice, ID: main, Secondary Actions: Raise"];
    const els = [];
    if (calc.display !== "0") els.push({ line: "texte Description: Dernière expression, Value: 1" });
    els.push({ line: `zone de défilement ID: StandardInputView;value:${calc.display}, Secondary Actions: Copier` });
    els.push({ line: `texte Description: Modifier le champ, Value: ${calc.display}` });
    for (const [desc, id] of keys) {
      const shownId = id === "AllClear" && calc.display !== "0" ? "Clear" : id;
      const shownDesc = id === "AllClear" && calc.display !== "0" ? "Effacer" : desc;
      els.push({ line: `bouton Description: ${shownDesc}, ID: ${shownId}`, key: id });
    }
    els.forEach((e, i) => out.push(`\t\t${i + 1} ${e.line}`));
    return { text: out.join("\n"), els };
  };
  const press = (key) => {
    calc.clicks.push(key);
    if (key === "AllClear") Object.assign(calc, { display: "0", pending: null, op: null, typedSince: false });
    else if (key === "Seven" || key === "Six") {
      const digit = key === "Seven" ? "7" : "6";
      calc.display = calc.typedSince ? calc.display + digit : digit;
      calc.typedSince = true;
    }
    else if (key === "Multiply") Object.assign(calc, { pending: Number(calc.display), op: "*", typedSince: false });
    else if (key === "Equals" && calc.op) Object.assign(calc, { display: String(calc.pending * Number(calc.display)), op: null, typedSince: false });
  };
  const app = {
    async getAXState(opts = {}) {
      return lines().text;
    },
    async click(target) {
      if (Array.isArray(target)) return;
      const el = lines().els[target - 1];
      if (!el) throw new Error(`Computer Use server error -10005: ${target} is an invalid element ID`);
      if (el.key) press(el.key);
    },
    async typeText(text, index) {
      if (index !== undefined) throw new Error("Typing into a specific element is only supported on Linux.");
    },
    async setValue() {},
    async pressKey() {},
    async getScreenshot() {},
  };
  return { app, calc };
}

test("parses tree lines, fields and diff markers", () => {
  const { cuParse } = kernel({});
  const els = cuParse(
    'Window: "X", App: X.\n\t\t\t12 bouton Description: 7, ID: Seven\n~\t\t\t5 texte Description: Modifier le champ, Value: 98\n\t\t478 text field (settable) Value: chandail, ID: search-input\nThe focused UI element is 478 text field',
  );
  assert.deepEqual(plain(els.map((e) => e.index)), [12, 5, 478]);
  assert.equal(els[0].head, "bouton");
  assert.deepEqual(plain(els[0].fields), { Description: "7", ID: "Seven" });
  assert.equal(els[1].fields.Value, "98");
  assert.equal(els[2].head, "text field (settable)");
  assert.equal(els[2].fields.ID, "search-input");
});

test("acceptance 1: the Calculator by ID only shows 42", async () => {
  const { app, calc } = calculator();
  const k = kernel({});
  k.cuDecorate(app);
  calc.display = "98"; // left over from earlier: AllClear shows as Clear
  const first = await app.click({ id: "AllClear" });
  assert.match(first.note, /used ID "Clear"/);
  for (const id of ["AllClear", "Seven", "Multiply", "Six", "Equals"]) await app.click({ id });
  assert.equal(calc.display, "42");
});

test("an ID matches only an equal ID, without regard to case; part of an ID only with a RegExp", async () => {
  const { app } = calculator();
  const k = kernel({});
  k.cuDecorate(app);
  const ids = async (sel) => plain((await k.cuQuery(app, sel)).map((e) => e.fields.ID));
  assert.deepEqual(await ids({ id: "Seven" }), ["Seven"]);
  assert.deepEqual(await ids({ id: "seven" }), ["Seven"]);
  assert.deepEqual(await ids({ id: /Standard/ }), ["StandardInputView;value:0"]);
  assert.deepEqual(await ids({ id: "StandardInputView" }), ["StandardInputView;value:0"]);
  assert.deepEqual(await ids({ id: "Sevenn" }), [], "a query that contains an ID does not match it");
  assert.deepEqual(await ids({ id: "BoutonInexistant" }), [], "boutoninexistant contains nine, but is not Nine");
  assert.deepEqual(await ids({ id: "Seve" }), [], "an ID that contains the query does not match it either");
  assert.deepEqual(await ids({ id: "Zzzz" }), []);
});

test("a mistyped ID fails and names the close ID as a candidate, without clicking it", async () => {
  const { app, calc } = calculator();
  const k = kernel({});
  k.cuDecorate(app);
  await rejectsWith(app.click({ id: "Sevenn", timeout: 0 }), /No element matches \{ id: "Sevenn", timeout: 0 \}[\s\S]*Close candidates:[\s\S]*ID: Seven\b/);
  await rejectsWith(app.click({ id: "BoutonInexistant", timeout: 0 }), /^\[puppet\] No element matches \{ id: "BoutonInexistant"/);
  assert.deepEqual(calc.clicks, [], "nothing was clicked");
  await app.click({ id: "Seven" });
  assert.deepEqual(calc.clicks, ["Seven"]);
});

test("waitFor an ID that does not exist times out instead of matching an ID it contains", async () => {
  const { app } = calculator();
  const k = kernel({});
  k.cuDecorate(app);
  const t0 = Date.now();
  await rejectsWith(app.waitFor({ id: "BoutonInexistant" }, { timeout: 500, interval: 100 }), /waitFor \{ id: "BoutonInexistant" \} timed out after 500 ms/);
  assert.ok(Date.now() - t0 >= 500);
  const ok = plain(await app.waitFor({ id: "Nine" }, { timeout: 500 }));
  assert.match(ok.element, /ID: Nine/);
});

test("acceptance 6: a stale index fails with the explicit message instead of clicking another element", async () => {
  const { app, calc } = calculator();
  const k = kernel({});
  k.cuDecorate(app);
  const tree = k.cuParse(await app.getAXState({ full: true }));
  const idx = (id) => tree.find((e) => e.fields.ID === id).index;
  await app.click(idx("Seven")); // the display leaves 0: everything below moves by one
  await assert.rejects(app.click(idx("Six")), (e) => {
    assert.match(e.message, /^\[puppet\] Stale element index \d+: .*current snapshot #\d+/);
    assert.match(e.message, /getAXState\(\{ full: true \}\)/);
    assert.match(e.message, /it is now index \d+/);
    return true;
  });
  assert.deepEqual(calc.clicks, ["Seven"], "nothing else was clicked");
});

test("two stale indices from the same old read both fail; the first check does not refresh the second", async () => {
  const { app, calc } = calculator();
  const k = kernel({});
  k.cuDecorate(app);
  calc.display = "98";
  const tree = k.cuParse(await app.getAXState({ full: true }));
  const idx = (id) => tree.find((e) => e.fields.ID === id).index;
  await app.click({ id: "AllClear" }); // the display goes back to 0: everything below moves up by one
  await rejectsWith(app.click(idx("Seven")), /^\[puppet\] Stale element index \d+:/);
  await rejectsWith(app.click(idx("Six")), /^\[puppet\] Stale element index \d+:/);
  assert.deepEqual(calc.clicks, ["AllClear"], "nothing else was clicked");
});

test("the service's -10005 becomes the same explicit message", async () => {
  const { app } = calculator();
  const k = kernel({});
  k.cuDecorate(app);
  await rejectsWith(app.click(99), /^\[puppet\] Stale element index 99:/);
});

test("getAXState({ full: true }) reads the whole tree", async () => {
  const seen = [];
  const app = { getAXState: async (o) => (seen.push(o), "0 fenêtre"), click: async () => {} };
  const k = kernel({});
  k.cuDecorate(app);
  await app.getAXState({ full: true });
  await app.getAXState();
  assert.deepEqual(plain(seen), [{ disableDiffing: true }, {}]);
});

test("role \"text field\" also names a search text field (Wikipedia's search box)", async () => {
  const tree = '0 AXWebArea Wikipédia\n\t7 search text field (settable) Description: Rechercher sur Wikipédia, ID: searchInput\n\t8 button Rechercher';
  const k = kernel({});
  const found = k.cuMatch(k.cuParse(tree), { role: "text field", name: /Rechercher/i });
  assert.deepEqual(plain(found.map((e) => e.index)), [7]);
});

test("selectors match typographic hyphens and apostrophes as typed (System Settings' \"Wi‑Fi\" row)", async () => {
  const tree = "0 fenêtre standard Réglages\n\t7 row (selectable) Wi\u2011Fi\n\t8 row (selectable) Bluetooth\n\t9 link Description: Livraison gratuite dès 50 $ d\u2019achats";
  const k = kernel({});
  const els = k.cuParse(tree);
  assert.deepEqual(plain(k.cuMatch(els, { role: "row", text: "Wi-Fi" }).map((e) => e.index)), [7]);
  assert.deepEqual(plain(k.cuMatch(els, { text: "d'achats" }).map((e) => e.index)), [9]);
});

test("a selector with several matches lists them, and one without lists close candidates", async () => {
  const tree = "0 window\n\t1 button Rechercher\n\t2 button Rechercher\n\t3 link Description: Mon sac";
  const app = { getAXState: async () => tree, click: async () => {} };
  const k = kernel({});
  k.cuDecorate(app);
  await rejectsWith(app.click({ text: "Rechercher" }), /2 elements match \{ text: "Rechercher" \}.*\n  1 button Rechercher\n  2 button Rechercher/s);
  await rejectsWith(app.click({ text: "sac à dos", timeout: 0 }), /No element matches .*Close candidates:\n  3 link/s);
  assert.equal((await app.click({ text: "Rechercher", nth: 1 })).clicked, 2);
});

test("getApp accepts the localized displayName from listApps", async () => {
  const opened = [];
  const cua = {
    async getApp(name) {
      if (name !== "com.apple.calculator") throw new Error(`Invalid app: ${name}`);
      opened.push(name);
      return calculator().app;
    },
    async listApps() {
      return [{ id: "com.apple.calculator", displayName: "Calculatrice", isRunning: true }, { id: "com.apple.Notes", displayName: "Notes" }];
    },
  };
  kernel({ cua });
  const app = await cua.getApp("calculatrice");
  assert.deepEqual(plain(opened), ["com.apple.calculator"]);
  assert.equal(typeof app.waitFor, "function");
  await rejectsWith(cua.getApp("Nothing"), /Invalid app: Nothing/);
});

// A tab on a search page: clicking "Rechercher" opens a panel with the search field, which takes
// the focus; typing renumbers the tree as suggestions appear; Enter navigates.
function searchTab() {
  // The panel's field shows up two reads after the click, as it slides in.
  const page = { open: false, opening: 0, value: "", url: "https://www.simons.ca/fr", focus: null, setValueCalls: 0 };
  const tree = () => {
    if (page.opening && --page.opening === 0) Object.assign(page, { open: true, focus: 417 });
    const out = [`Browser tab: 1, Title: "Simons", URL: "${page.url}".`, `0 AXWebArea Simons, URL: simons.ca/fr`, "\t24 button Rechercher", "\t25 container Rechercher"];
    const field = page.value ? 478 : 417;
    if (page.open) out.push(`\t${field} text field (settable) ${page.value ? `Value: ${page.value}, ID: search-input` : "search-input"}`);
    out.push("\t199 text field (settable) Inscrivez-vous à l'infolettre");
    out.push("\t31 link Description: Mon sac, Value: simons.ca/fr/cart, ID: myBag");
    out.push("\t49 link Description: Pour elle, Value: simons.ca/fr/vetements-femme/les-incontournables-…");
    out.push("\t224 link Description: FAQ, Value: …");
    if (page.focus) out.push(`The focused UI element is ${page.focus}`);
    return out.join("\n");
  };
  const tab = {
    id: "1",
    playwright: {
      async evaluate(fn, arg) {
        const src = String(fn);
        if (src.includes("elementFromPoint")) return { tag: "a", role: null, text: "Derniers produits vus", href: "https://www.simons.ca/fr/x", id: null, arg };
        if (src.includes("innerText") && !src.includes("name:")) {
          return [
            { href: "https://www.simons.ca/fr/p/chandail-1", text: "swatch swatch swatch\nChandail en laine\n89,00 $ CAN\n+4\nAPERÇU RAPIDE DÉTAILS COMPLETS" },
            { href: "https://www.simons.ca/fr/p/chandail-1", text: "Chandail en laine" },
            { href: "https://www.simons.ca/fr/p/pantalon-2", text: "Pantalon <b>laine</b>\n120,00 $ CAN" },
            { href: "https://www.simons.ca/fr/cart", text: "Mon sac" },
            { href: "javascript:void(0)", text: "Menu" },
          ];
        }
        return [
          { href: "https://www.simons.ca/fr/vetements-femme/les-incontournables-contemporains--1234", name: "Pour elle" },
          { href: "https://www.simons.ca/fr/cart", name: "Mon sac" },
          { href: "https://www.simons.ca/fr/informations/faq--a1", name: "FAQ" },
        ];
      },
      async waitForLoadState() {},
    },
    async goto(url) {
      page.url = url;
    },
    async url() {
      return page.url;
    },
    async getAXState() {
      return tree();
    },
    async click(target) {
      // The search field shows up and takes the focus a few reads later, after the tree has looked
      // settled: until then the button keeps the focus and the newsletter field is the only one.
      if (target === 24) Object.assign(page, { opening: 4, focus: 24 });
      if (target === 417 || target === 478) page.focus = target;
    },
    async typeText(index, text) {
      if (index !== null && !Number.isInteger(index)) throw new Error("Browser input requires an element index from the latest AX snapshot, or null to use current focus.");
      if (page.focus === 417 || page.focus === 478) {
        page.value += text;
        page.focus = 478;
      }
    },
    async setValue(index, value) {
      page.setValueCalls++;
      if (index !== 478 && index !== 417) throw new Error(`Accessibility element ${index} is stale or missing`);
      page.value = value;
    },
    async pressKey(index, key) {
      if (key === "Enter" && page.value) page.url = `https://www.simons.ca/fr/recherche--search?query=${encodeURIComponent(page.value)}`;
    },
  };
  // Like the tab cua_repl hands the kernel: its membrane ignores an assignment to an own method.
  const membrane = new Proxy(tab, {
    set(obj, key, value, receiver) {
      if (receiver !== membrane) return Reflect.defineProperty(receiver, key, { value, writable: true, enumerable: true, configurable: true });
      if (typeof obj[key] === "function" && Object.hasOwn(obj, key)) return true;
      obj[key] = value;
      return true;
    },
  });
  return { tab: membrane, page };
}

test("acceptance 2: search with selectors, typeText checks its work and submits", async () => {
  let { tab, page } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  const clicked = await tab.click({ text: "Rechercher" });
  assert.equal(clicked.clicked, 24, "the button, not the container");
  const typed = await tab.typeText({ role: "text field" }, "chandail laine homme", { submit: true });
  assert.equal(typed.target, 417, "the focused field, not the newsletter one");
  assert.equal(page.value, "chandail laine homme");
  assert.match(await tab.url(), /query=chandail%20laine%20homme/);
});

test("typeText(text) alone types at the focus in a tab; typeText(index, text) still works", async () => {
  let { tab, page } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  page.open = true;
  page.focus = 417;
  await tab.typeText("abc");
  assert.equal(page.value, "abc");
  await tab.typeText(478, "def");
  assert.equal(page.value, "abcdef");
});

test("a stale tab index gets the explicit message", async () => {
  let { tab } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  await rejectsWith(tab.setValue(300, "x"), /^\[puppet\] Stale element index 300:/);
});

test("acceptance 3: goto stays in the same tab", async () => {
  let { tab } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  const url = "https://www.simons.ca/fr/recherche--search?query=pantalon%20homme%20laine";
  assert.deepEqual(plain(await tab.goto(url, { waitUntil: "load" })), { url });
});

test("acceptance 4: extractLinks returns clean text and full URLs, one per URL", async () => {
  let { tab } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  const links = await tab.extractLinks({ match: /\$ CAN/ });
  assert.deepEqual(plain(links), [
    { text: "Chandail en laine 89,00 $ CAN", href: "https://www.simons.ca/fr/p/chandail-1" },
    { text: "Pantalon laine 120,00 $ CAN", href: "https://www.simons.ca/fr/p/pantalon-2" },
  ]);
});

test("getAXState({ fullUrls: true }) restores URLs cut with an ellipsis", async () => {
  let { tab } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  const text = await tab.getAXState({ fullUrls: true });
  assert.match(text, /Value: https:\/\/www\.simons\.ca\/fr\/vetements-femme\/les-incontournables-contemporains--1234/);
  assert.match(text, /224 link Description: FAQ, Value: https:\/\/www\.simons\.ca\/fr\/informations\/faq--a1/, "a value cut to … alone, by the link's name");
  assert.equal(k.written.length, 1, "printed once");
});

test("a click at coordinates says what it hit", async () => {
  let { tab } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  const r = await tab.click([100, 200]);
  assert.deepEqual(plain(r.clicked), [100, 200]);
  assert.equal(r.hit.text, "Derniers produits vus");
});

test("waitFor polls until the condition holds or times out", async () => {
  let { tab, page } = searchTab();
  const k = kernel({});
  tab = k.cuDecorate(tab);
  setTimeout(() => (page.url = "https://www.simons.ca/fr/recherche--search?query=x"), 300);
  assert.deepEqual(plain(await tab.waitFor({ urlIncludes: "recherche" }, { timeout: 3000, interval: 100 })), { url: page.url });
  await rejectsWith(tab.waitFor({ text: "Nulle part" }, { timeout: 200, interval: 50 }), /waitFor .* timed out after 200 ms/);
});

test("an app bound before the kernel loaded is decorated in place", async () => {
  const { app } = calculator();
  const k = kernel({});
  await k.cuAdopt(app);
  assert.equal((await app.click({ id: "Seven" })).element, "bouton Description: 7, ID: Seven");
});
