# Alconost Brief Tracker

A single-file dashboard that tracks **active Wrike cards assigned to Alpha Alconost** whose comments either **tag Alpha** (the cards carrying the real brief) or **mention LQA** (translation done, ready for your LQA check).

No framework, no build step, no dependencies.

## Open it

Two ways:

- **Double-click `start.bat`** (recommended) — launches the local server and opens <http://localhost:5178>. Here the in-page **Refresh** button pulls live data from Wrike and reloads. Keep the little black window open while you use it; close it to stop. (Equivalent to running `node server.mjs`.)
- **Double-click `index.html`** — works offline from the last snapshot (`data.js`), but the Refresh button only reloads (no live pull).

## Refresh the data from Wrike

Either click **Refresh** while running via `node server.mjs`, or from a terminal:

```bash
node refresh.mjs
```

Requires Node 18+ (uses global `fetch`). It's fast — **~5–8 seconds** — because it makes only a handful of API calls:

1. reads the access token from `../wrike.env`,
2. pulls all cards in the Alconost folder in one paged fetch (the list already carries due date, permalink and updated-date), keeps the **Active** ones assigned to Alpha,
3. pulls the account's recent comments and flags cards whose comments **tag Alpha** (`rel="KUAYQ3T3"`), or are an **LQA handoff** (tags Alpha + mentions `\bLQA\b` + authored by someone other than Alpha),
4. resolves commenter names in one batch call and rewrites `data.js`.

The token never touches the browser — only this Node script uses it. After it runs, just reload `index.html`.

**On the comment window:** Wrike's account-wide comments endpoint covers the **last 7 days**. To make sure an older tag/LQA note isn't lost, the script merges with the previous `data.js` — so once a card is tracked it stays tracked while it's active. Keep refreshing at least weekly and nothing slips through. (The shipped `data.js` seeds this, so you start complete.)

## Files

- `index.html` — the dashboard (HTML + CSS + vanilla JS, all inline)
- `data.js` — the data snapshot (`window.__DATA__` + `window.__META__`)
- `refresh.mjs` — pulls fresh data from Wrike into `data.js` (CLI or imported by the server)
- `server.mjs` — serves the dashboard and powers the in-page Refresh button

## Using it

- **Tabs** across the top filter by IP (MPY / PF / …), each with a count.
- Click a **column header** (Card / Lang) to sort.
- The **Done** checkbox marks a card handled — it's remembered in your browser (localStorage), survives reloads, and greys the row out.
- The **LQA** column shows a pill when someone **else** tags you in a comment mentioning LQA (i.e. a "ready for LQA" handoff — not your own comments, and not LQA notes that don't tag you); hover it to read that comment. The **LQA ready** toggle filters to just those cards.

## Send a card to Google Sheets

Each row has a **→ Sheet** button that creates a tab (named by the card ticket, e.g. `PF-65623`) in the right spreadsheet and fills **Project name**, **Languages codes**, the per-language column headers, and **Original content** (the strings parsed from the brief comment). Translation columns and Context are left for you/Crowdin.

- MPY tickets → *MPY-Linguini and Farming translations batches*; PF tickets → *Pixel Flow translations*.
- It only writes columns A–E + the header row, so translations you add later are never overwritten.

**One-time setup** (see `sheets-connector.gs`):

1. Open <https://script.google.com> → New project, paste `sheets-connector.gs`, Save.
2. Deploy ▸ New deployment ▸ **Web app**, Execute as **Me**, Access **Anyone**. Authorize, copy the `/exec` URL.
3. First time you click **→ Sheet**, paste that URL when prompted (stored in your browser after).

Notes: the send is fire-and-forget (browser can't read the response), so use the **open sheet** link in the toast to verify. Original content only auto-fills for briefs whose strings are listed inline in the comment; VO/externally-linked tasks arrive with an empty Original content column to fill manually.

## Notes

- "Master card" column: a card with that ticket number exists in the folder (✓) or is **missing** (✕) — when missing, this row is the de-facto brief.
- Due-date colouring: red = overdue, amber = due within 7 days, green = later.
