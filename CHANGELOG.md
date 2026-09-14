# Brief Tracker — Changelog

Major changes only. Newest first.

## Hosting & shared state
- Deployed as a static site + Node serverless functions on **Vercel**, gated by a shared **SITE_PASSWORD**.
- All per-card state is **shared across users** via Neon Postgres (`bt_state`): Done, LQA dismiss, Translation/LQA status, deletes, new-message bubble, Crowdin tasks, sheet tabs, preferred linguists, LQA report links.
- Tokens (Wrike, Crowdin, Alconost, DB) stay **server-side**; the browser only ever holds the shared password.

## Wrike cards
- Card list built live from the localization folder (Active + Alpha-responsible), with tagged/LQA comments, master/parent detection, and per-language data from **"Copy localization"** tickets only (assigned to Alpha Alconost).
- **Vendor Estimate** value shown per sibling in the localization-cards modal.

## Google Sheets (Apps Script connector)
- **Create sheet tab** per card (formatted header, wrapped cells, EN-AU last, Wrike link).
- **Import translations** from Crowdin back into the sheet's language columns.
- Source of truth for Crowdin is the sheet's **Original content** column (hand-added lines are picked up).
- Detects tabs created outside the dashboard.

## Crowdin
- **Create/update source file** from the sheet, then **create translation tasks** (one per language, EN-AU excluded, deduped).
- **New-strings** detection: re-uploading spawns tasks scoped to just the added rows (`New strings…`, `#2 New strings…`).
- **Proofreading** tasks on "Translation done"; live **progress**; deleted tasks reconciled away.
- **File scan**: finds a card's Crowdin file (dashboard `.csv` or plugin `.xlsx`) even if made elsewhere, and shows per-language progress with correct per-language editor links.

## Alconost alphas (internal MCP app)
- **Create alphas** from Crowdin tasks — translation, proofreading, and LQA stages.
- Per-language **preferred-linguists** table (editable in-app, shared) drives the translator (`execId`).
- **Manager picker**: create alphas as igor or dasha (per-manager API keys in env).
- Each alpha **tagged** `#<ticket>` + `#loc` (translation) / `#lqa` (LQA).

## Attachments & LQA
- **Wrike attachment → Google Drive**: pick an attachment, upload to a `<ticket>` subfolder, share it, and drop the link into the sheet's **Context** column.
- **LQA report**: creates a shared spreadsheet (`<task> _LQA Report`) in the LQA Drive folder, one tab per language with review columns, and checks access to the assets link.

## UI
- Per-card **Automate** modal grouping Sheet / Crowdin / LQA actions with step-by-step enablement.
- **Localization-cards** modal (list view, VE badges, "Copy all" links).
- Columns: Tickets, Workflow, Translation status dropdown (TR/PR/DONE), Done, LQA — with the localization ≡ opener and new-message bubble.
