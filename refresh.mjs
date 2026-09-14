// Pull data from the live Wrike account and write data.js.
// CLI:     node refresh.mjs
// Module:  import { refreshData } from './refresh.mjs'
// Tracks:  ACTIVE cards assigned to Alpha Alconost whose comments TAG Alpha
//          or mention LQA (translation done → ready for your LQA check).
// Fast path: 1 folder pull + 1 account-wide /comments call + 1 batch contacts
//            call (~8 requests total, a few seconds) — no per-card fetches.
// Needs Node 18+ (global fetch). Reads the token from ../wrike.env.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = path.join(ROOT, 'data.js')

const ALPHA = 'KUAYQ3T3'
const FOLDER = 'IEAEUAE4I5H5Z5DR'
const API = 'https://www.wrike.com/api/v4'
const LQA = /\bLQA\b/i

export function readToken() {
  // Prefer an env var (for hosting, e.g. Lovable secrets); fall back to ../wrike.env locally.
  if (process.env.WRIKE_TOKEN) return process.env.WRIKE_TOKEN.trim()
  const envPath = path.resolve(ROOT, '..', 'wrike.env')
  const m = fs.readFileSync(envPath, 'utf8').match(/Access token:\s*(\S+)/i)
  if (!m) throw new Error('No WRIKE_TOKEN env var and no Access token in ' + envPath)
  return m[1]
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeApi(token) {
  return async function api(pathname) {
    let delay = 1000
    for (let i = 0; i < 8; i++) {
      const res = await fetch(API + pathname, { headers: { Authorization: 'Bearer ' + token } })
      if (res.status === 429) { await sleep(delay); delay = Math.min(delay * 2, 20000); continue }
      if (!res.ok) throw new Error(res.status + ' ' + pathname + ' ' + (await res.text()).slice(0, 200))
      return await res.json()
    }
    throw new Error('rate-limited giving up: ' + pathname)
  }
}

const ticket = (t) => t.split('_')[0].trim()
// known localization language codes, to filter out ticket/IP codes (MPY, PF, …)
const LANGS = new Set(('EN EN-US EN-AU EN-GB EN-CA FR FR-FR FR-CA DE ES ES-ES ES-MX ES-LA ES-419 IT PT PT-PT ' +
  'PT-BR JP JA KO ZH ZH-CN ZH-TW ZH-HK CHS CHT NL PL TR AR RU SV DA FI NO NB CS HU RO SK BG HR SR UK EL HE ' +
  'HI TH VI ID MS FIL TL FA UR').split(' '))
const NAMECODE = /[A-Za-z][A-Za-z()./\- ]{1,22}?[-–]\s*([A-Z]{2,3}(?:-[A-Z]{2,3})?)\b/g
// extract language codes ("Turkish - TR", "French - FR-FR", …), whitelist-filtered
const langCodes = (text) => {
  const out = []
  let m
  NAMECODE.lastIndex = 0
  while ((m = NAMECODE.exec(text || ''))) {
    const c = m[1].toUpperCase()
    if (LANGS.has(c) && !out.includes(c)) out.push(c)
  }
  return out
}
// language code from a card title's "…Localization_XX…" suffix (used across a group's siblings)
const TITLELANG = /[Ll]ocali[sz]ation_([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)/
const titleCode = (title) => { const m = (title || '').match(TITLELANG); return m ? m[1].toUpperCase() : null }
// The tagged brief comment sometimes states the real master code (the in-card field is often stale/wrong),
// e.g. "Original Master project code is MPY-59379" (note: typos like "Originanal" appear). Prefer this.
const MASTERCODE = /master\s*project\b[\s\S]{0,25}?\b([A-Z]{2,5}-\d{3,})/i
const masterCodeFrom = (texts) => { for (const t of texts || []) { const m = stripHtml(t).match(MASTERCODE); if (m) return m[1].toUpperCase() } return null }
// normalize Scopely's title codes to standard language codes
const NORM = { GE: 'DE', SP: 'ES-ES', PT: 'PT-PT' }
// Parse the description's auto-generated "Localizations" table into {lang, url} rows (the real
// per-language sub-cards), ignoring any hand-typed "Languages/Countries" list in the description.
const localizationRows = (desc) => {
  if (!desc) return []
  const start = desc.search(/Localizations?\s*\(auto/i)
  if (start < 0) return []
  let seg = desc.slice(start)
  const end = seg.search(/End of localizations/i)
  if (end >= 0) seg = seg.slice(0, end)
  const rows = []; const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let tr
  while ((tr = trRe.exec(seg))) {
    const cell = tr[1]
    const cm = cell.match(/<td[^>]*>\s*([A-Za-z][A-Za-z0-9-]{1,7})\s*<\/td>/i); if (!cm) continue
    const code = cm[1].toUpperCase(); const norm = NORM[code] || code; if (!LANGS.has(norm)) continue
    const hm = cell.match(/href="([^"]+)"/i)
    rows.push({ lang: norm, url: hm ? decodeEnt(hm[1]) : '' })
  }
  return rows
}
const permId = (u) => { const m = (u || '').match(/id[=#](\d+)/); return m ? m[1] : '' }

// --- Original-content extraction (the strings to translate, from the brief comment) ---
const decodeEnt = (s) => (s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
const cleanLine = (s) => decodeEnt((s || '').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim()
const STOP = /^(the original|original video|original master|\d+\s*l[na]*guages?|please|thank|let me know|cc:|note:?|http|visual reference|just one language)/i
const ENUM = /^(?:op|option|opt|var|variant|line|#)?\s*\d+\s*[:.)\-]\s*(\S.*)$/i
function parseStrings(text) {
  // 1) explicit <li> list
  const lis = [...(text || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => cleanLine(m[1])).filter(Boolean)
  if (lis.length) return lis
  // 2) enumerated lines: "Op1: …", "Option 2: …", "1. …", "1) …", "1: …" (label stripped)
  const hits = []
  for (const part of (text || '').split(/<br\s*\/?>|\n/)) {
    const t = cleanLine(part); if (!t) continue
    const em = t.match(ENUM); if (em) hits.push(em[1].trim())
  }
  if (hits.length) return hits
  // 3) "The lines are:" block, until a stop line
  const m = (text || '').match(/lines?\s*(?:are|to translate|:)\s*:?\s*(?:<br\s*\/?>)?([\s\S]*)/i)
  if (m) {
    const out = []
    for (const part of m[1].split(/<br\s*\/?>|\n/)) {
      const t = cleanLine(part)
      if (!t) continue
      if (STOP.test(t)) break
      out.push(t)
    }
    if (out.length) return out
  }
  return []
}
// pick the brief comment (tags Alpha, not by Alpha) that yields the most strings
function extractStrings(texts) {
  let best = []
  for (const t of texts) { const s = parseStrings(t); if (s.length > best.length) best = s }
  return best
}
const stripHtml = (s) =>
  (s || '').replace(/<[^>]+>/g, ' ').replace(/&#64;/g, '@').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
// like stripHtml but keeps line breaks (<br>, block-close tags → newlines) for displaying comment text
const stripHtmlLines = (s) => decodeEnt(
  (s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
).replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

// Read the previous snapshot so signals older than the 7-day comment window persist.
function readCache() {
  try {
    const txt = fs.readFileSync(DATA_FILE, 'utf8')
    const arr = txt.split('window.__META__')[0].replace('window.__DATA__ =', '').trim().replace(/;$/, '')
    const cache = {}
    for (const c of JSON.parse(arr)) cache[c.id] = c
    return cache
  } catch { return {} }
}

// When did we last refresh? (from data.js's __META__.generatedAt)
function readLastRefresh() {
  try {
    const txt = fs.readFileSync(DATA_FILE, 'utf8')
    const m = txt.match(/window\.__META__\s*=\s*(\{[^\n]*\})/)
    return m ? Date.parse(JSON.parse(m[1]).generatedAt) : NaN
  } catch { return NaN }
}

// Wrike's /comments accepts at most a 7-day updatedDate range, so cover the gap
// since the last refresh in ≤7-day slices (with a 1-day overlap, capped at 56 days).
const DAY = 86400000
function commentWindows(lastRefreshMs) {
  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  let start = Number.isNaN(lastRefreshMs) ? now - 7 * DAY : lastRefreshMs - DAY
  if (start < now - 56 * DAY) start = now - 56 * DAY
  if (start > now - 7 * DAY) start = now - 7 * DAY // always look back at least a full window
  const windows = []
  for (let s = start; s < now; s += 7 * DAY) {
    windows.push({ start: iso(s), end: iso(Math.min(s + 7 * DAY, now)) })
  }
  return windows
}

export async function refreshData(log = () => {}) {
  const token = readToken()
  const api = makeApi(token)

  // 1) All folder tasks — the default list already includes dates, permalink, updatedDate;
  //    we add customFields + responsibleIds. ~5 requests for the whole folder.
  log('Fetching folder tasks…')
  let all = []
  let pageToken = ''
  do {
    const q = `/folders/${FOLDER}/tasks?fields=%5B%22customFields%22%2C%22responsibleIds%22%5D&pageSize=1000${pageToken ? '&nextPageToken=' + pageToken : ''}`
    const body = await api(q)
    all = all.concat(body.data)
    pageToken = body.responseCounters?.nextPageToken || body.nextPageToken || ''
  } while (pageToken)
  log('  folder cards: ' + all.length)

  const cfDefs = Object.fromEntries((await api('/customfields')).data.map((c) => [c.id, c.title]))
  const cf = (t, title) => {
    for (const c of t.customFields || []) if (cfDefs[c.id] === title) return c.value || ''
    return ''
  }
  const present = new Set(all.map((t) => ticket(t.title)))
  // group every folder card by its Original Master Project value (for group-wide languages)
  const byOMP = {}
  for (const t of all) { const o = cf(t, 'Original Master Project'); if (o) (byOMP[o] ||= []).push(t) }
  const idToTicket = {}
  for (const t of all) { const id = permId(t.permalink); if (id) idToTicket[id] = ticket(t.title) }
  const activeAlpha = all.filter((t) => t.status === 'Active' && (t.responsibleIds || []).includes(ALPHA))
  log('  active cards for Alpha: ' + activeAlpha.length)

  // 2) Account-wide comments, covering every day since the last refresh in ≤7-day
  //    windows (Wrike caps each request at 7 days). Deduped by comment id.
  const windows = commentWindows(readLastRefresh())
  log(`Fetching comments in ${windows.length} window(s) (${windows.length * 7}d lookback max)…`)
  const seen = new Set()
  const comments = []
  for (const w of windows) {
    const range = encodeURIComponent(JSON.stringify({ start: w.start, end: w.end }))
    let ct = ''
    do {
      const body = await api(`/comments?updatedDate=${range}` + (ct ? '&nextPageToken=' + ct : ''))
      for (const c of body.data) if (!seen.has(c.id)) { seen.add(c.id); comments.push(c) }
      ct = body.responseCounters?.nextPageToken || body.nextPageToken || ''
    } while (ct)
  }
  const byTask = {}
  for (const c of comments) (byTask[c.taskId] ||= []).push(c)
  log('  comments scanned: ' + comments.length)

  const cache = readCache()
  const prevIds = new Set(Object.keys(cache)) // to flag cards new since the last refresh

  // 3) Detect signals per active card (fresh comments), fall back to cache for older signals.
  const authors = new Set()
  const conv = (list) => list.map((c) => ({ authorId: c.authorId, date: c.createdDate, text: stripHtmlLines(c.text).slice(0, 1200) }))
  const tracked = []
  for (const t of activeAlpha) {
    const cs = (byTask[t.id] || []).slice().sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''))
    const tagC = cs.filter((c) => (c.text || '').includes(`rel="${ALPHA}"`))
    // LQA = someone ELSE telling Alpha it's ready: mentions LQA, tags Alpha, not authored by Alpha.
    const lqaC = cs.filter((c) =>
      c.authorId !== ALPHA && (c.text || '').includes(`rel="${ALPHA}"`) && LQA.test(stripHtml(c.text)))
    const cached = cache[t.id]

    const taggedAlpha = tagC.length > 0 || !!cached?.taggedAlpha
    const lqa = lqaC.length > 0 || !!cached?.lqa
    if (!taggedAlpha && !lqa) continue

    tagC.forEach((c) => authors.add(c.authorId))
    lqaC.forEach((c) => authors.add(c.authorId))
    tracked.push({
      task: t, taggedAlpha, lqa,
      // prefer fresh comments; keep cached ones if nothing fresh this window
      tagComments: tagC.length ? conv(tagC) : (cached?.tagComments || []),
      lqaComments: lqaC.length ? conv(lqaC) : (cached?.lqaComments || []),
    })
  }
  log('  tracked (tags Alpha or mentions LQA): ' + tracked.length)

  // 4) Resolve commenter names in one batch call; reuse names already in cache.
  const names = {}
  const need = [...authors].filter(Boolean)
  if (need.length) {
    try {
      const d = await api('/contacts/' + need.join(','))
      for (const c of d.data) names[c.id] = `${c.firstName || ''} ${c.lastName || ''}`.trim()
    } catch { /* fall back to ids below */ }
  }
  const nameOf = (id) => names[id] || id
  const resolve = (list) => list.map((c) => (c.author ? c : { author: nameOf(c.authorId), date: c.date, text: c.text }))

  log('Extracting languages…')
  // Descriptions for tracked cards (batched) — authoritative Localizations table.
  const descById = {}
  const dids = tracked.map((x) => x.task.id)
  for (let i = 0; i < dids.length; i += 100) {
    try { const dd = await api('/tasks/' + dids.slice(i, i + 100).join(',')); for (const tk of dd.data) descById[tk.id] = tk.description || '' } catch { /* skip */ }
  }
  const cards = []
  for (const { task, taggedAlpha, lqa, tagComments, lqaComments } of tracked) {
    const title = task.title
    const self = ticket(title)
    // Fetch this card's comments once — used for language codes, brief strings, and the stated master code.
    let fullComments = []
    try { fullComments = (await api(`/tasks/${task.id}/comments`)).data } catch { /* keep going */ }
    // Original content + stated master come from the brief comment(s) tagging Alpha (not authored by Alpha).
    const briefTexts = fullComments
      .filter((c) => c.authorId !== ALPHA && (c.text || '').includes(`rel="${ALPHA}"`))
      .map((c) => c.text)
    // Effective master ref: the code stated in the brief comment WINS over the (often stale/wrong) field.
    // If it names this card's own ticket, the card is its own master → top-level parent (no ref).
    let mref = masterCodeFrom(briefTexts) || cf(task, 'Original Master Project')
    if (mref === self) mref = ''
    // Role from the master ref, NOT the title: pointing at a parent = child; empty = top-level parent.
    const role = mref ? 'brief (de-facto master)' : 'master card'
    // languages = the whole group's codes (siblings sharing the master ref; a master card's group is
    // keyed by its own ticket), union any language list in this card's comments, falling back to its field.
    const key = role === 'master card' ? self : mref
    const ownRows = localizationRows(descById[task.id] || '')
    // The "Copy localization" cards under this card's master (in the folder) are the source of truth.
    const groupKey = mref || self
    const locCards = []; const seenTk = new Set()
    for (const s of (byOMP[groupKey] || [])) {
      const tkk = ticket(s.title)
      if (tkk === self || seenTk.has(tkk)) continue
      if (!/copy\s*localization/i.test(s.title)) continue
      const lang = NORM[titleCode(s.title)] || titleCode(s.title) || ''
      if (!lang) continue
      seenTk.add(tkk); locCards.push({ lang, ticket: tkk, url: s.permalink || '' })
    }
    // languages: from the copy-localization cards; else auto-table; else sibling titles + comment codes
    const raw = []
    if (locCards.length) { for (const lc of locCards) raw.push(lc.lang) }
    else if (ownRows.length) { for (const r of ownRows) raw.push(r.lang) }
    else {
      for (const s of (key && byOMP[key]) || []) { const c = titleCode(s.title); if (c) raw.push(c) }
      for (const c of fullComments) for (const code of langCodes(stripHtml(c.text))) raw.push(code)
    }
    // related dropdown: ONLY the copy-localization cards (no auto-table fallback)
    const relItems = locCards.map((lc) => ({ lang: lc.lang, ticket: lc.ticket, url: lc.url }))
    if (mref && relItems.length && !relItems.some((i) => i.ticket === self)) { const selfLang = NORM[titleCode(title)] || titleCode(title) || ''; relItems.unshift({ lang: selfLang, ticket: self, url: task.permalink, self: true }) }
    const related = { type: mref ? 'siblings' : 'children', parent: mref || null, items: relItems }
    const strings = extractStrings(briefTexts)
    const src = raw.length ? raw : langCodes(cf(task, 'Language'))
    const langs = []
    for (const x of src) { const y = NORM[x] || x; if (!langs.includes(y)) langs.push(y) }
    // drop a base code (ES) when a regional variant (ES-ES) is also present
    const languages = langs.filter((x) => !langs.some((y) => y !== x && y.startsWith(x + '-')))
    cards.push({
      id: task.id, ticket: ticket(title), title,
      language: languages[0] || '', languages, strings,
      status: task.status, permalink: task.permalink, due: task.dates?.due || null,
      role,
      masterRef: mref || null, masterExists: mref ? present.has(mref) : null,
      projectName: cf(task, 'Project Name'), urgency: cf(task, 'Urgency'),
      deliverables: cf(task, 'Nr of deliverables'), deliveryMonth: cf(task, 'Delivery Month'),
      vendor: cf(task, 'Flamed Vendor'), related,
      taggedAlpha, lqa, isNew: prevIds.size > 0 && !prevIds.has(task.id),
      tagComments: resolve(tagComments), lqaComments: resolve(lqaComments),
    })
  }

  cards.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.ticket.localeCompare(b.ticket))
  const generatedAt = new Date().toISOString()
  const out = 'window.__DATA__ = ' + JSON.stringify(cards, null, 2) + ';\n' +
              'window.__META__ = ' + JSON.stringify({ generatedAt }) + ';\n'
  fs.writeFileSync(DATA_FILE, out)
  log(`Wrote data.js with ${cards.length} cards.`)
  return { count: cards.length, generatedAt }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now()
  refreshData((m) => console.log(m))
    .then((r) => console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`))
    .catch((e) => { console.error(e); process.exit(1) })
}
