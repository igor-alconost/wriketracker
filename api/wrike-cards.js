// Vercel serverless function (Node): GET /api/wrike-cards
// Returns { generatedAt, cards } fetched live from Wrike. The token stays here on
// the server via the WRIKE_TOKEN env var and never reaches the browser.
// Light, stateless port of refresh.mjs (windowed comments — stays well under Vercel's
// 10s function limit; no per-card fetches).

const ALPHA = 'KUAYQ3T3'
const FOLDER = 'IEAEUAE4I5H5Z5DR'
const API = 'https://www.wrike.com/api/v4'

const ticket = (t) => t.split('_')[0].trim()
const LANGS = new Set(('EN EN-US EN-AU EN-GB EN-CA FR FR-FR FR-CA DE ES ES-ES ES-MX ES-LA ES-419 IT PT PT-PT ' +
  'PT-BR JP JA KO ZH ZH-CN ZH-TW ZH-HK CHS CHT NL PL TR AR RU SV DA FI NO NB CS HU RO SK BG HR SR UK EL HE ' +
  'HI TH VI ID MS FIL TL FA UR').split(' '))
const NORM = { GE: 'DE', SP: 'ES-ES', PT: 'PT-PT' }
const NAMECODE = /[A-Za-z][A-Za-z()./\- ]{1,22}?[-–]\s*([A-Z]{2,3}(?:-[A-Z]{2,3})?)\b/g
const TITLELANG = /[Ll]ocali[sz]ation_([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)/
// The tagged brief comment sometimes states the real master code (the in-card field is often stale/wrong),
// e.g. "Original Master project code is MPY-59379" (typos like "Originanal" occur). Prefer this over the field.
const MASTERCODE = /master\s*project\b[\s\S]{0,25}?\b([A-Z]{2,5}-\d{3,})/i
const STOP = /^(the original|original video|original master|\d+\s*l[na]*guages?|please|thank|let me know|cc:|note:?|http|visual reference|just one language)/i
const ENUM = /^(?:op|option|opt|var|variant|line|#)?\s*\d+\s*[:.)\-]\s*(\S.*)$/i

const decodeEnt = (s) => (s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
const cleanLine = (s) => decodeEnt((s || '').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim()
const stripHtml = (s) => decodeEnt((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
// like stripHtml but keeps line breaks (<br>, block-close tags → newlines) for displaying comment text
const stripHtmlLines = (s) => decodeEnt(
  (s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
).replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

function langCodes(text) {
  const out = []; let m; NAMECODE.lastIndex = 0
  while ((m = NAMECODE.exec(text || ''))) { const c = m[1].toUpperCase(); if (LANGS.has(c) && !out.includes(c)) out.push(c) }
  return out
}
const titleCode = (title) => { const m = (title || '').match(TITLELANG); return m ? m[1].toUpperCase() : null }
const masterCodeFrom = (texts) => { for (const t of texts || []) { const m = stripHtml(t).match(MASTERCODE); if (m) return m[1].toUpperCase() } return null }
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
function parseStrings(text) {
  const lis = [...(text || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => cleanLine(m[1])).filter(Boolean)
  if (lis.length) return lis
  const hits = []
  for (const part of (text || '').split(/<br\s*\/?>|\n/)) { const t = cleanLine(part); if (!t) continue; const em = t.match(ENUM); if (em) hits.push(em[1].trim()) }
  if (hits.length) return hits
  const m = (text || '').match(/lines?\s*(?:are|to translate|:)\s*:?\s*(?:<br\s*\/?>)?([\s\S]*)/i)
  if (m) { const out = []; for (const part of m[1].split(/<br\s*\/?>|\n/)) { const t = cleanLine(part); if (!t) continue; if (STOP.test(t)) break; out.push(t) } if (out.length) return out }
  return []
}
function extractStrings(texts) { let best = []; for (const t of texts) { const s = parseStrings(t); if (s.length > best.length) best = s } return best }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function makeApi(token) {
  return async function api(pathname) {
    let delay = 1000
    for (let i = 0; i < 8; i++) {
      const res = await fetch(API + pathname, { headers: { Authorization: 'Bearer ' + token } })
      if (res.status === 429) { await sleep(delay); delay = Math.min(delay * 2, 20000); continue }
      if (!res.ok) throw new Error(`Wrike ${pathname} → ${res.status} ${(await res.text()).slice(0, 160)}`)
      return res.json()
    }
    throw new Error('rate-limited: ' + pathname)
  }
}
function commentWindows(days) {
  const now = Date.now(), DAY = 86400000
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const w = []
  for (let s = now - days * DAY; s < now; s += 7 * DAY) w.push({ start: iso(s), end: iso(Math.min(s + 7 * DAY, now)) })
  return w
}

export async function buildCards(token, lookbackDays) {
  const api = makeApi(token)
  let all = []; let pageToken = ''
  do {
    const q = `/folders/${FOLDER}/tasks?fields=%5B%22customFields%22%2C%22responsibleIds%22%5D&pageSize=1000${pageToken ? `&nextPageToken=${pageToken}` : ''}`
    const body = await api(q); all = all.concat(body.data)
    pageToken = body.responseCounters?.nextPageToken || body.nextPageToken || ''
  } while (pageToken)

  const cfDefs = Object.fromEntries((await api('/customfields')).data.map((c) => [c.id, c.title]))
  const cf = (t, title) => { for (const c of t.customFields || []) if (cfDefs[c.id] === title) return c.value || ''; return '' }
  const present = new Set(all.map((t) => ticket(t.title)))
  const byOMP = {}
  for (const t of all) { const o = cf(t, 'Original Master Project'); if (o) (byOMP[o] ||= []).push(t) }
  const idToTicket = {}
  for (const t of all) { const id = permId(t.permalink); if (id) idToTicket[id] = ticket(t.title) }
  const activeAlpha = all.filter((t) => t.status === 'Active' && (t.responsibleIds || []).includes(ALPHA))

  const seen = new Set(); const comments = []
  for (const w of commentWindows(lookbackDays)) {
    const range = encodeURIComponent(JSON.stringify({ start: w.start, end: w.end })); let ct = ''
    do {
      const body = await api(`/comments?updatedDate=${range}${ct ? `&nextPageToken=${ct}` : ''}`)
      for (const c of body.data) if (!seen.has(c.id)) { seen.add(c.id); comments.push(c) }
      ct = body.responseCounters?.nextPageToken || body.nextPageToken || ''
    } while (ct)
  }
  const byTask = {}
  for (const c of comments) (byTask[c.taskId] ||= []).push(c)

  const LQA = /\bLQA\b/i
  const authors = new Set()
  const conv = (list) => list.map((c) => ({ authorId: c.authorId, date: c.createdDate, text: stripHtmlLines(c.text).slice(0, 1200) }))
  const tracked = []
  for (const t of activeAlpha) {
    const cs = (byTask[t.id] || []).slice().sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''))
    const tagC = cs.filter((c) => (c.text || '').includes(`rel="${ALPHA}"`))
    const lqaC = cs.filter((c) => c.authorId !== ALPHA && (c.text || '').includes(`rel="${ALPHA}"`) && LQA.test(stripHtml(c.text)))
    if (!tagC.length && !lqaC.length) continue
    tagC.forEach((c) => authors.add(c.authorId)); lqaC.forEach((c) => authors.add(c.authorId))
    tracked.push({
      task: t, taggedAlpha: tagC.length > 0, lqa: lqaC.length > 0, tagComments: conv(tagC), lqaComments: conv(lqaC),
      briefTexts: cs.filter((c) => c.authorId !== ALPHA && (c.text || '').includes(`rel="${ALPHA}"`)).map((c) => c.text),
      commentTexts: cs.map((c) => c.text),
    })
  }

  const names = {}; const need = [...authors].filter(Boolean)
  if (need.length) { try { const d = await api('/contacts/' + need.join(',')); for (const c of d.data) names[c.id] = `${c.firstName || ''} ${c.lastName || ''}`.trim() } catch { /* ids */ } }
  const nameOf = (id) => names[id] || id
  const resolve = (list) => list.map((c) => ({ author: nameOf(c.authorId), date: c.date, text: c.text }))

  // Descriptions for tracked cards (batched) — used for the authoritative Localizations table.
  const descById = {}
  const tids = tracked.map((x) => x.task.id)
  for (let i = 0; i < tids.length; i += 100) {
    try { const dd = await api('/tasks/' + tids.slice(i, i + 100).join(',')); for (const tk of dd.data) descById[tk.id] = tk.description || '' } catch { /* skip on error */ }
  }

  const cards = []
  for (const { task, taggedAlpha, lqa, tagComments, lqaComments, briefTexts, commentTexts } of tracked) {
    const title = task.title
    const self = ticket(title)
    // Effective master ref: the code stated in the brief comment WINS over the (often stale/wrong) field.
    // If it names this card's own ticket, the card is its own master → top-level parent (no ref).
    let mref = masterCodeFrom(briefTexts) || cf(task, 'Original Master Project')
    if (mref === self) mref = ''
    // Role from the master ref, NOT the title: pointing at a parent = child; empty = top-level parent.
    const role = mref ? 'brief (de-facto master)' : 'master card'
    const key = role === 'master card' ? self : mref
    const ownRows = localizationRows(descById[task.id] || '')
    // The "Copy localization" cards under this card's master (in the folder) are the source of truth.
    const groupKey = mref || self
    const locCards = []; const seenTk = new Set()
    for (const s of (byOMP[groupKey] || [])) {
      const tkk = ticket(s.title)
      if (tkk === self || seenTk.has(tkk)) continue
      if (!/copy\s*localization/i.test(s.title)) continue
      if (!(s.responsibleIds || []).includes(ALPHA)) continue   // only copy-loc tickets assigned to Alpha Alconost
      const lang = NORM[titleCode(s.title)] || titleCode(s.title) || ''
      if (!lang) continue
      seenTk.add(tkk); locCards.push({ lang, ticket: tkk, url: s.permalink || '', title: s.title, vest: cf(s, 'Vendor Estimate') })
    }
    // languages: from the copy-localization cards; else auto-table; else sibling titles + comment codes
    const raw = []
    if (locCards.length) { for (const lc of locCards) raw.push(lc.lang) }
    else if (ownRows.length) { for (const r of ownRows) raw.push(r.lang) }
    else {
      for (const s of (key && byOMP[key]) || []) { const c = titleCode(s.title); if (c) raw.push(c) }
      for (const text of commentTexts) for (const code of langCodes(stripHtml(text))) raw.push(code)
    }
    // related dropdown: ONLY the copy-localization cards (no auto-table fallback)
    const relItems = locCards.map((lc) => ({ lang: lc.lang, ticket: lc.ticket, url: lc.url, title: lc.title, vest: lc.vest }))
    // Only add the "this card" chip when the card's own ticket is itself a copy-localization ticket.
    if (mref && relItems.length && !relItems.some((i) => i.ticket === self) && /copy\s*localization/i.test(title)) { const selfLang = NORM[titleCode(title)] || titleCode(title) || ''; relItems.unshift({ lang: selfLang, ticket: self, url: task.permalink, title, self: true, vest: cf(task, 'Vendor Estimate') }) }
    const related = { type: mref ? 'siblings' : 'children', parent: mref || null, items: relItems }
    const strings = extractStrings(briefTexts)
    const srcArr = raw.length ? raw : langCodes(cf(task, 'Language'))
    const dedup = []; for (const x of srcArr) { const y = NORM[x] || x; if (!dedup.includes(y)) dedup.push(y) }
    const languages = dedup.filter((x) => !dedup.some((y) => y !== x && y.startsWith(x + '-')))
    cards.push({
      id: task.id, ticket: ticket(title), title, language: languages[0] || '', languages, strings,
      status: task.status, permalink: task.permalink, due: task.dates?.due || null, role,
      masterRef: mref || null, masterExists: mref ? present.has(mref) : null,
      projectName: cf(task, 'Project Name'), urgency: cf(task, 'Urgency'),
      deliverables: cf(task, 'Nr of deliverables'), deliveryMonth: cf(task, 'Delivery Month'),
      vendor: cf(task, 'Flamed Vendor'), taggedAlpha, lqa, related,
      tagComments: resolve(tagComments), lqaComments: resolve(lqaComments),
    })
  }
  cards.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.ticket.localeCompare(b.ticket))
  return { generatedAt: new Date().toISOString(), cards }
}

// Shared-password gate. Returns {ok} or {ok:false,code,error}.
// If SITE_PASSWORD isn't set, auth is disabled (local dev) and this passes.
export function checkAuth(providedKey) {
  const pw = process.env.SITE_PASSWORD
  if (!pw) return { ok: true }
  if (providedKey && providedKey === pw) return { ok: true }
  return { ok: false, code: 401, error: 'Wrong or missing password' }
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = process.env.WRIKE_TOKEN
  if (!token) { res.status(500).json({ error: 'WRIKE_TOKEN env var not set' }); return }
  const lookback = Number(process.env.LOOKBACK_DAYS || '30')
  try {
    const data = await buildCards(token, lookback)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json(data)
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
