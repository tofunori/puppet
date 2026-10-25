## Puppet additions

Puppet adds the following to `cua`, apps and tabs from your **second** `js` call in a kernel on. Every original signature keeps working.

**Selectors instead of indices.** `click`, `typeText`, `setValue`, `selectText`, `performSecondaryAction` (and `pressKey` in a tab) take a selector wherever they take an element index. It is resolved on a fresh tree at call time, so you never need to read indices by hand. Keys: `id` (the `ID:` field, equal without regard to case; part of an ID only with a RegExp: `{ id: /StandardInputView/ }`), `text` (anywhere in the line), `name` (name, description or value only, string or RegExp), `role` (English or the tree's language: "button", "text field", "link"…), `value`, `nth`, `timeout` (ms to wait for it to appear, default 3000). A plain string is an ID, or else a text. No match, or several equally good ones, fails with the candidates listed.
```javascript
await app.click({ id: "Seven" });
await tab.click({ text: "Rechercher", role: "button" });
await tab.click({ name: /Popular/i });
let hits = await cuQuery(tab, { role: "link", name: /chandail/i }); // matches, without acting
```

**Stale indices.** Indices change whenever the interface changes. In an app, a stale index used to click whatever element now had that number. Now an action by index first checks that the index still names the element last read there, and otherwise fails with `[puppet] Stale element index N … (current snapshot #K)`, where the element went, and what to do. `{ check: false }` in the options skips the check.

**Full tree.** `getAXState()` prints a diff from the previous read ("There has been no change…"). `getAXState({ full: true })` prints the whole tree. In a tab, `getAXState({ fullUrls: true })` replaces URLs cut with `…` by the full `href` when the page has exactly one match.

**typeText.** Native app: `typeText(text)` types at the focus. Tab: `typeText(index | null, text)`, and now also `typeText(text)` at the focus. Both: `typeText(target, text, opts)`, where `target` is an index or a selector. With a target, Puppet clicks it to focus it, types, and checks that a field shows the text (a tab falls back to `setValue`), otherwise it fails. `{ submit: true }` presses Enter after typing; `{ verify: false }` skips the check.
```javascript
await tab.click({ text: "Rechercher" });
await tab.typeText({ role: "text field" }, "chandail laine homme", { submit: true });
await tab.waitFor({ urlIncludes: "recherche" });
```

**Navigate in the same tab.** `tab.goto(url, { waitUntil: "load" })`, `tab.back()`, `tab.forward()`, `tab.reload()`, `tab.close()`, `tab.url()`. Use them instead of opening a new tab with `createBrowserTab`.
```javascript
await tab.goto("https://www.simons.ca/fr/recherche--search?query=pantalon%20homme%20laine", { waitUntil: "load" });
```

**Waiting.** No fixed `setTimeout`. `waitFor(cond, { timeout: 10000 })` on an app or a tab, where `cond` is any selector, `{ urlIncludes }` (tab) or an async function returning true. `waitForIdle({ timeout, quiet: 600 })` waits for the page load (tab) and for the tree to stop changing. Navigation after Enter is asynchronous: wait for the URL.
```javascript
await tab.waitFor({ text: "articles" }, { timeout: 15000 });
await app.waitForIdle();
```

**Clicks at coordinates** return what they hit: in a tab `{ clicked: [x, y], hit: { tag, role, text, href } }` (tab coordinates are CSS pixels, as in its screenshots); in an app, `{ clicked, hit: null, changes }` with the first lines of the tree diff: the app API gives no element positions, so it cannot say which element was under the point. Check it before going on. Clicks by index or selector return `{ clicked: index, element: "<its line>" }`.

**Links from a page.** `tab.extractLinks({ match: /\$ CAN/, limit: 200, strip: [/extra noise/] })` returns `[{ text, href }]`, one per URL, read from the page: full URLs, visible text without markup, swatches, "+4" or "quick view" noise.
```javascript
let products = await tab.extractLinks({ match: /\$/ });
nodeRepl.write(JSON.stringify(products.slice(0, 5), null, 1));
```

**Apps by displayName.** `cua.getApp("Calculatrice")` works with the name `getState()` and `listApps()` show, localized, without regard to case or accents.

**Screenshots.** `getScreenshot()` already shows the image. Do not pass it to `nodeRepl.emitImage` as well; use `getScreenshot({ emit: false })` when you only need the bytes (JPEG).
