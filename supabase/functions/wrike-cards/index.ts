// Supabase Edge Function: wrike-cards
// Returns the tracked localization cards as JSON, fetching live from the Wrike API.
// The Wrike token stays server-side (secret WRIKE_TOKEN) and never reaches the browser.
//
// Deploy in Supabase, set secret:  WRIKE_TOKEN = <your Wrike access token>
// (optional)  LOOKBACK_DAYS = 30   — how far back to scan comments for tag/LQA signals
//
// Faithful Deno port of refresh.mjs (minus the local-file cache and the "isNew" flag,
// which the frontend computes by comparing ids against localStorage).

const ALPHA = 'KUAYQ3T3'
const FOLDER = 'IEAEUAE4I5H5Z5DR'
const API = 'https://www.wrike.com/api/v4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ticket = (t: string) => t.split('_')[0].trim()

const LANGS = new Set(('EN EN-US EN-AU EN-GB EN-CA FR FR-FR FR-CA DE ES ES-ES ES-MX ES-LA ES-419 IT PT PT-PT ' +
  'PT-BR JP JA KO ZH ZH-CN ZH-TW ZH-HK CHS CHT NL PL TR AR RU SV DA FI NO NB CS HU RO SK BG HR SR UK EL HE ' +
  'HI TH VI ID MS FIL TL FA UR').split(' '))
const NAMECODE = /[A-Za-z][A-Za-z()./\- ]{1,22}?[-–]\s*([A-Z]{2,3}(?:-[A-Z]{2,3})?)\b/g
function langCodes(text: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  NAMECODE.lastIndex = 0
  while ((m = NAMECODE.exec(text || ''))) { const c = m[1].toUpperCase(); if (LANGS.has(c) && !out.includes(c)) out.push(c) }
  return out
}
const TITLELANG = /[Ll]ocali[sz]ation_([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)/
const titleCode = (title: string) => { const m = (title || '').match(TITLELANG); return m ? m[1].toUpperCase() : null }
const NORM: Record<string, string> = { GE: 'DE', SP: 'ES-ES', PT: 'PT-PT' }

const decodeEnt = (s: string) => (s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
const cleanLine = (s: string) => decodeEnt((s || '').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim()
const stripHtml = (s: string) => decodeEnt((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const STOP = /^(the original|original video|original master|\d+\s*l[na]*guages?|please|thank|let me know|cc:|note:?|http|visual reference|just one language)/i
const ENUM = /^(?:op|option|opt|var|variant|line|#)?\s*\d+\s*[:.)\-]\s*(\S.*)$/i
function parseStrings(text: string): string[] {
  const lis = [...(text || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => cleanLine(m[1])).filter(Boolean)
  if (lis.length) return lis
  const hits: string[] = []
  for (const part of (text || '').split(/<br\s*\/?>|\n/)) { const t = cleanLine(part); if (!t) continue; const em = t.match(ENUM); if (em) hits.push(em[1].trim()) }
  if (hits.length) return hits
  const m = (text || '').match(/lines?\s*(?:are|to translate|:)\s*:?\s*(?:<br\s*\/?>)?([\s\S]*)/i)
  if (m) {
    const out: string[] = []
    for (const part of m[1].split(/<br\s*\/?>|\n/)) { const t = cleanLine(part); if (!t) continue; if (STOP.test(t)) break; out.push(t) }
    if (out.length) return out
  }
  return []
}
function extractStrings(texts: string[]): string[] {
  let best: string[] = []
  for (const t of texts) { const s = parseStrings(t); if (s.length > best.length) best = s }
  return best
}

function makeApi(token: string) {
  return async function api(pathname: string): Promise<any> {
    let delay = 1000
    for (let i = 0; i < 8; i++) {
      const res = await fetch(API + pathname, { headers: { Authorization: 'Bearer ' + token } })
      if (res.status === 429) { await sleep(delay); delay = Math.min(delay * 2, 20000); continue }
      if (!res.ok) throw new Error(res.status + ' ' + pathname + ' ' + (await res.text()).slice(0, 200))
      return await res.json()
    }
    throw new Error('rate-limited: ' + pathname)
  }
}

// fixed lookback windows (≤7 days each) — stateless, so we scan a rolling window
function commentWindows(days: number) {
  const now = Date.now(), DAY = 86400000
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const start = now - days * DAY
  const w: { start: string; end: string }[] = []
  for (let s = start; s < now; s += 7 * DAY) w.push({ start: iso(s), end: iso(Math.min(s + 7 * DAY, now)) })
  return w
}

async function buildCards(token: string, lookbackDays: number) {
  const api = makeApi(token)

  let all: any[] = []
  let pageToken = ''
  do {
    const q = `/folders/${FOLDER}/tasks?fields=%5B%22customFields%22%2C%22responsibleIds%22%5D&pageSize=1000${pageToken ? '&nextPageToken=' + pageToken : ''}`
    const body = await api(q)
    all = all.concat(body.data)
    pageToken = body.responseCounters?.nextPageToken || body.nextPageToken || ''
  } while (pageToken)

  const cfDefs: Record<string, string> = Object.fromEntries((await api('/customfields')).data.map((c: any) => [c.id, c.title]))
  const cf = (t: any, title: string) => { for (const c of t.customFields || []) if (cfDefs[c.id] === title) return c.value || ''; return '' }
  const present = new Set(all.map((t) => ticket(t.title)))
  const byOMP: Record<string, any[]> = {}
  for (const t of all) { const o = cf(t, 'Original Master Project'); if (o) (byOMP[o] ||= []).push(t) }
  const activeAlpha = all.filter((t) => t.status === 'Active' && (t.responsibleIds || []).includes(ALPHA))

  const seen = new Set<string>()
  const comments: any[] = []
  for (const w of commentWindows(lookbackDays)) {
    const range = encodeURIComponent(JSON.stringify({ start: w.start, end: w.end }))
    let ct = ''
    do {
      const body = await api(`/comments?updatedDate=${range}` + (ct ? '&nextPageToken=' + ct : ''))
      for (const c of body.data) if (!seen.has(c.id)) { seen.add(c.id); comments.push(c) }
      ct = body.responseCounters?.nextPageToken || body.nextPageToken || ''
    } while (ct)
  }
  const byTask: Record<string, any[]> = {}
  for (const c of comments) (byTask[c.taskId] ||= []).push(c)

  const LQA = /\bLQA\b/i
  const authors = new Set<string>()
  const conv = (list: any[]) => list.map((c) => ({ authorId: c.authorId, date: c.createdDate, text: stripHtml(c.text).slice(0, 240) }))
  const tracked: any[] = []
  for (const t of activeAlpha) {
    const cs = (byTask[t.id] || []).slice().sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''))
    const tagC = cs.filter((c) => (c.text || '').includes(`rel="${ALPHA}"`))
    const lqaC = cs.filter((c) => c.authorId !== ALPHA && (c.text || '').includes(`rel="${ALPHA}"`) && LQA.test(stripHtml(c.text)))
    if (!tagC.length && !lqaC.length) continue
    tagC.forEach((c) => authors.add(c.authorId)); lqaC.forEach((c) => authors.add(c.authorId))
    tracked.push({ task: t, taggedAlpha: tagC.length > 0, lqa: lqaC.length > 0, tagComments: conv(tagC), lqaComments: conv(lqaC) })
  }

  const names: Record<string, string> = {}
  const need = [...authors].filter(Boolean)
  if (need.length) { try { const d = await api('/contacts/' + need.join(',')); for (const c of d.data) names[c.id] = `${c.firstName || ''} ${c.lastName || ''}`.trim() } catch { /* ids */ } }
  const nameOf = (id: string) => names[id] || id
  const resolve = (list: any[]) => list.map((c) => ({ author: nameOf(c.authorId), date: c.date, text: c.text }))

  const cards: any[] = []
  for (const { task, taggedAlpha, lqa, tagComments, lqaComments } of tracked) {
    const mref = cf(task, 'Original Master Project')
    const title = task.title
    const role = title.includes('Loc Collaboration') ? 'master card' : 'brief (de-facto master)'
    const key = role === 'master card' ? ticket(title) : mref
    const raw: string[] = []
    for (const s of (key && byOMP[key]) || []) { const c = titleCode(s.title); if (c) raw.push(c) }
    let strings: string[] = []
    try {
      const full = await api(`/tasks/${task.id}/comments`)
      for (const c of full.data) for (const code of langCodes(stripHtml(c.text))) raw.push(code)
      const briefTexts = full.data.filter((c: any) => c.authorId !== ALPHA && (c.text || '').includes(`rel="${ALPHA}"`)).map((c: any) => c.text)
      strings = extractStrings(briefTexts)
    } catch { /* keep going */ }
    const src = raw.length ? raw : langCodes(cf(task, 'Language'))
    const dedup: string[] = []
    for (const x of src) { const y = NORM[x] || x; if (!dedup.includes(y)) dedup.push(y) }
    const languages = dedup.filter((x) => !dedup.some((y) => y !== x && y.startsWith(x + '-')))
    cards.push({
      id: task.id, ticket: ticket(title), title, language: languages[0] || '', languages, strings,
      status: task.status, permalink: task.permalink, due: task.dates?.due || null, role,
      masterRef: mref || null, masterExists: mref ? present.has(mref) : null,
      projectName: cf(task, 'Project Name'), urgency: cf(task, 'Urgency'),
      deliverables: cf(task, 'Nr of deliverables'), deliveryMonth: cf(task, 'Delivery Month'),
      vendor: cf(task, 'Flamed Vendor'), taggedAlpha, lqa,
      tagComments: resolve(tagComments), lqaComments: resolve(lqaComments),
    })
  }
  cards.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.ticket.localeCompare(b.ticket))
  return { generatedAt: new Date().toISOString(), cards }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const token = Deno.env.get('WRIKE_TOKEN')
  if (!token) return new Response(JSON.stringify({ error: 'WRIKE_TOKEN secret not set' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  const lookback = Number(Deno.env.get('LOOKBACK_DAYS') || '30')
  try {
    const data = await buildCards(token, lookback)
    return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
