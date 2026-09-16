# Scopely Tracker

A simple dashboard that shows every localization task coming in from Wrike in one list, and helps you move each one through the whole flow — from a spreadsheet, into Crowdin, out to translators, and through LQA — with a few clicks.

## Opening it

Open the dashboard link in your browser and enter the shared password. That's it — no install.

The list loads automatically. Press **Refresh** (top right) any time to pull the latest briefs from Wrike.

## Reading the list

Each row is one brief. The columns tell you, at a glance:

- **Description / Tickets** — what the brief is and its localization ticket(s). The **≡** icon opens the full list of localization cards for that brief, with a **Copy all** button.
- **Languages** — the languages requested.
- **LQA ready** — lights up when a teammate has finished translation and handed the brief over for your LQA check. Use the **LQA ready** filter at the top to show only those.
- **Translation / LQA / Done** — the check-off columns you use to mark progress (see below).
- **Automate** — the button that opens the workflow window for that brief.

New briefs are marked **NEW**. Overdue briefs show in red, soon-due in amber.

## Marking progress

Two people share this board — one handles translation/proofreading, the other handles LQA — so the check-offs are how you hand a brief over:

- The translator ticks **Translation** when translation (and proofreading, if any) is done.
- The LQA person ticks **LQA** when the review is done.
- Tick **Done** to close it out — the row greys and drops to the bottom.

Everything you tick is shared, so both of you always see the same state.

## The Automate button — running a brief through the flow

Click **Automate** on a row to open its workflow window. It has three groups of buttons, meant to be used left to right. A button is greyed with a small ✓ (already done) or 🔒 (do the step before it first) — hover it to see why.

### Sheet

- **Create tab** — makes a tab for this brief in the right Google Sheet and fills in the source text.
- **Import translations** — later, pulls the finished translations back from Crowdin into that sheet.

### Crowdin

- **Upload source** — sends the brief's text into Crowdin so it can be translated.
- **Create tasks + alphas** — creates the translation tasks in Crowdin and places the matching orders with the translators automatically.

### LQA (appears when a brief is ready for LQA)

- **Create report** — makes the LQA report spreadsheet, one tab per language, and shares it.
- **Create LQA alphas** — places the LQA review orders with the reviewers.

### Attaching the reference image

When you send a brief to the sheet, you can pick a file attached to the Wrike card. It's uploaded to Google Drive and its link is dropped into the sheet (shown as **Visual asset:**), so translators always have the reference in front of them. Do this **before** uploading to Crowdin so the link travels with the text.

## Progress and issues

Open a row's **▸** panel to see how far along each language is in Crowdin. If a translator has raised a question or flagged a problem on a string, you'll see a red **⚠ issue** marker here so you can jump in.

## Translators

The **Translators** button (top right) opens a table where you set the preferred person for each language and stage (translation, proofreading, LQA). Those are the people the dashboard orders work from. Edit it and **Save** — it's shared with everyone.

## Found a bug or have an idea?

Use the **💬 Feedback** button in the bottom-right corner to jot it down. It's saved and visible to the whole team.

---

*First time on a new computer:* you'll be asked once for the shared password, and (the first time you send something to a sheet) for the Google Apps Script link — both are shared, so you only ever do this once.
