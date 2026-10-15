# LMArena Stealth Model Selector

A **client-side only, Chrome (Manifest V3)** extension that reveals and lets you pick the
hidden / non-selectable models on [arena.ai](https://arena.ai) — across text, code, image,
search and video pages, in both **Direct** and **Side-by-Side** modes.

Nothing leaves your browser. No server, no proxy, no account, no remote code. It only patches
what *your own page* already received from Arena.

---

## Install (unpacked, 30 seconds)

1. Download this repo (or just `dist/lmarena-stealth-1.0.0.zip` and unzip it).
2. Go to `chrome://extensions`, turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick the folder that contains `manifest.json`
   (the repo root, or the extracted folder).
4. Open `https://arena.ai`, then **reload the tab** (the page-world hook has to be in place
   before Arena's scripts boot).
5. Click the floating **“Stealth”** pill at the bottom-right of arena.ai.

Works unchanged on `arena.ai`, `www.arena.ai` and `canaryarena.ai`.

---

## What it actually does

Three things, in order of how much they matter:

### 1. Unlocks the catalog (this is the “hidden models” part)

Arena ships its full model list inside the React Flight (RSC) payload as
`{"initialModels":[…]}` and marks the ones it does not want you to pick with
`"userSelectable": false`. There is also a kill-switch flag entry for Opus.

`main.js` runs in the **page's own JS world at `document_start`**, before any Arena code, and:

* intercepts `self.__next_f.push([1, "…"])` — the inline chunks React uses to hydrate — and
  rewrites `userSelectable` before the app ever parses it;
* does the same for later RSC fetches (`_rsc=…`) by cloning the response;
* escapes-aware, so it works on both the inline-script form (`\"userSelectable\":false`)
  and the plain JSON form, and never corrupts the payload;
* neutralises the `disable-opus` flag value and flips Opus entries even with
  *Show hidden* off (that's the **Restore Opus** toggle).

Result: hidden models appear in **Arena's own dropdown**, not just in a side panel.

### 2. Stealth select — force a hidden model into the next message

Unhiding is not always enough: the UI may still refuse a retired entry, and some codenames never
show up in a picker at all. Arena sends the chosen model on
`/nextjs-api/stream/create-evaluation` (and `…/post-to-evaluation`) as **`modelAId`**.

Tick **Force on send**, pick any model (or paste an id), and every outgoing evaluation request
from that tab is rewritten to that `modelAId` — plain JSON bodies, `URLSearchParams`, and Next's
length-prefixed *framed* bodies alike. The panel's status line confirms
`sent: <id>` and then `ran: <organization>` taken from the stream's own
`a2:{"type":"routed_model",…}` event, so you can see what actually served the answer.

### 3. The panel — pick and jump

The floating **Stealth** pill opens a panel with:

* the full catalog, with **hidden** entries badged and filtered to the top by default;
* search across name / organisation / capabilities / id, plus modality chips
  (Text · Image · Search · Video · All);
* click a row → the **internal model id goes to your clipboard**;
* one-click deep links to every mode, using the slug form:
  `https://arena.ai/text/direct?model_a=<slug>`, `/text/side-by-side?model_a=…`,
  `/code/…`, `/image/…`, `/search/…`, plus a raw-id variant;
* a **Force on send** switch and a “paste any model id” box for retired entries.

### Mode map

| Page | Direct | Side by side |
| --- | --- | --- |
| Text | `/text/direct?model_a=` | `/text/side-by-side?model_a=` |
| Code | `/code/direct?model_a=` | `/code/side-by-side?model_a=` |
| Image | `/image/direct?model_a=` | `/image/side-by-side?model_a=` |
| Search | `/search/direct?model_a=` | `/search/side-by-side?model_a=` |
| Battles | `/text` `/code` `/image` `/search` `/video` `/` | — |

Clicking a model in the panel offers all of those links with the selection already filled in.

---

## Popup

`Active` (master switch) · `Restore Opus` · `Show hidden` (flip *every*
`userSelectable:false`) · `Force on send` · cached catalog size + hidden count · reload button.

**Reload the arena.ai tab after toggling** — the page-world hook is installed at
`document_start`, so it can't be swapped into an already-running page.

---

## Verify it yourself

```bash
npm install        # only jsdom, for the DOM tests
npm test           # 4 suites, ~60 assertions
```

| Suite | What it proves |
| --- | --- |
| `manifest` | every file in the manifest exists, all scripts parse, hook is `world: MAIN` at `document_start`, and there is **no `eval`, no injected `<script>`, no remote URL** anywhere |
| `catalog` | an **unmodified 1,066-model arena.ai catalog** (126 of them hidden) is rebuilt into a real Flight payload and driven through the real files: scanner recovers all 1,066, the hook un-hides exactly the 126, Opus-only mode flips exactly the 24 Opus entries, every one of the 1,066 names yields a valid `?model_a=` value, and capability mapping covers the real keys |
| `page` | flight unlocking (escaped + plain, toggle matrix incl. Opus-scoped), JSON still parses after rewrite, `modelAId` rewrite for plain / `URLSearchParams` / framed bodies, unrelated endpoints untouched, `routed_model` stream tap |
| `panel` | hidden-only default filter, badges, clipboard copy, deep-link slugs, mode dropdown, force switch + paste-an-id, foreign `postMessage` ignored |
| `bridge` | `chrome.storage.sync` → `localStorage` → page world, live change propagation, corrupt-mirror recovery |

The tests run the real files — `main.js` is executed inside a `vm` window, `content.js` inside a
jsdom arena.ai page. `node tests/run.mjs page` needs no dependencies at all.

### Testing against the live site

This was built in a sandbox whose egress policy kills TLS to `arena.ai` (DNS resolves, TCP connects,
the handshake is dropped), so no automated run can drive the logged-in site from here. Two things
close that gap:

1. **`tests/fixtures/arena-catalog.real.json`** — a real captured catalog, used by the `catalog`
   suite above. That is where the two bugs in the *Bug fixes found by real data* section below came
   from.
2. **`tools/live-probe.js`** — paste it into the DevTools console on a logged-in arena.ai tab. It is
   read-only (sends nothing, reads no chat text, touches no cookies) and reports: what the server
   actually sent (model + hidden counts), whether the page-world hook rewrote it before the app
   parsed it, **which field the live evaluation request carries the model in**, and the
   `routed_model` event showing which model actually ran.

### Bug fixes found by real data

| Found | Impact | Fix |
| --- | --- | --- |
| `?model_a=` was being *slugified* (`gemini-3.6-flash` → `gemini-3-6-flash`) | would have broken deep links for **265 of 1,066** real names containing a dot | use the `publicName` lower-cased, verbatim — verified against your own `?model_a=gemini-3.6-flash` / `=max` examples |
| capability labels only knew `text`/`search`/`image` | **330** real models are `web`-capable and were shown as capability-less; `image` is an *object* (`{aspectRatios:[…]}`) not a boolean | map `text · web · image · search · video` from truthiness, not strict booleans |
| 102 `publicName`s appear more than once (one appears 15×) | a name-based link silently picks a sibling | panel now warns when a name is shared and offers a "pin this exact id" link |

---

## Honest limits

* **Visibility ≠ access.** The extension only changes what your browser sees and sends. If
  Arena has retired a model server-side, the request will simply fail or fall back — the
  `ran:` / `sent:` line in the panel is there so you can tell the difference instead of guessing.
* **Hidden ≠ available everywhere.** Forcing an image model into a text chat (or vice versa)
  will be rejected by the server; the error appears in Arena's own UI, unchanged.
* **It patches the page, not the network stack.** It hooks `fetch`/`XHR` in the page world.
  A future Arena build that changes endpoints or field names would need a small update
  (everything endpoint-specific lives in `EVAL_RE` and `rewriteEvalBody` in `main.js`).
* **First load after install** uses defaults until `chrome.storage.sync` answers; from the next
  reload your saved toggles drive it.
* **Names are not unique.** 102 real `publicName`s are duplicated in the catalog (one 15 times).
  A `?model_a=<name>` link picks whichever sibling the server resolves; the panel's
  *Pin this exact id* link is the unambiguous one.
* Deliberately **not** included: bundled historical model lists. Pasted/forced ids are the
  honest way to try a retired entry, since nobody can promise it still exists.

---

## Files

```
manifest.json     MV3 wiring: bridge (isolated) + page hook (MAIN) + panel, popup, badge
boot.js           isolated world, document_start: chrome.storage.sync -> localStorage mirror
main.js           page world, document_start: flight unlock, request rewrite, stream tap
models-scan.js    initialModels extraction from the Flight payload
model-utils.js    capability tags / validity helpers
content.js        the floating panel + deep links + force controls
styles.css        panel styles (namespaced under lm-)
popup.html/js     toggles, cached catalog preview
background.js     toolbar badge with the hidden-model count
pack.sh           builds dist/lmarena-stealth-<version>.zip
tests/            manifest, page-hook, live-catalog, panel and bridge suites
tools/live-probe.js  console probe for a logged-in arena.ai tab
```

`main.js` and the isolated-world scripts talk over `localStorage` (same origin, shared by both
worlds) plus `window.postMessage` — **no inline `<script>` injection**, which strict
`script-src` CSP would block anyway.
