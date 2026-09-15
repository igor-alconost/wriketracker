// Vercel serverless function (Node): POST /api/crowdin-scan
// Scans the Crowdin project for a source file matching a card's ticket (created by the dashboard
// OR by the plugin, .csv or .xlsx), and returns its per-language translation/approval progress.
import { checkAuth } from './wrike-cards.js'
import { readCrowdinToken } from './crowdin-file.js'
import { toCrowdinLang } from './crowdin-tasks.js'

const BASE = 'https://api.crowdin.com/api/v2'
const PROJECT = Number(process.env.CROWDIN_PROJECT_ID || 873652)

const stripExt = (n) => String(n || '').replace(/\.[^.]+$/, '')

// The editor URLs need the project slug + source language, not the numeric id — cache them.
let _proj = null
async function projectInfo(api) {
  if (_proj) return _proj
  try { const b = await api(`/projects/${PROJECT}`); _proj = { slug: b.data.identifier || String(PROJECT), src: b.data.sourceLanguageId || 'en' } }
  catch { _proj = { slug: String(PROJECT), src: 'en' } }
  return _proj
}
const editorUrl = (proj, fileId, langId) => `https://crowdin.com/editor/${proj.slug}/${fileId}` + (langId ? `/${proj.src}-${langId}` : '')

// Full project file list, cached briefly — Crowdin's `filter=` only searches the file NAME, but many
// files (Google Sheets → Crowdin, this connector) carry the ticket only in their TITLE, so we must
// scan every file's title too. One card-open triggers many potential matches; cache to avoid re-paging.
let _filesCache = null, _filesAt = 0
async function allFiles(api) {
  if (_filesCache && (Date.now() - _filesAt) < 60000) return _filesCache
  const out = []
  for (let offset = 0; offset <= 20000; offset += 500) {
    const b = await api(`/projects/${PROJECT}/files?limit=500&offset=${offset}`)
    const d = (b.data || []).map((x) => x.data)
    for (const f of d) out.push({ id: f.id, name: f.name, title: f.title })
    if (d.length < 500) break
  }
  _filesCache = out; _filesAt = Date.now()
  return out
}

// Which of these tickets have a Crowdin source file (by name or title)? One file-list call, no progress.
export async function scanIndex(token, tickets) {
  const auth = { Authorization: 'Bearer ' + token }
  const api = async (p) => {
    const r = await fetch(BASE + p, { headers: auth })
    const j = await r.json().catch(() => null)
    if (r.status >= 400) throw new Error(`Crowdin ${p} → ${r.status}`)
    return j
  }
  const all = await allFiles(api)
  const want = new Set((tickets || []).map(String))
  const index = {}
  for (const f of all) {
    let key = null
    if (f.title && want.has(f.title)) key = f.title
    else if (want.has(stripExt(f.name))) key = stripExt(f.name)
    if (!key) continue
    if (!index[key]) index[key] = []
    index[key].push({ fileId: f.id, name: f.name, title: f.title || null, url: `https://crowdin.com/editor/${PROJECT}/${f.id}` })
  }
  return { index }
}

// Count unresolved issues (linguist-raised string comments of type "issue") per file and per
// target language. Crowdin comments carry a stringId + languageId but no fileId, so we first map
// each file's string ids, then page the project's unresolved issues and bucket them.
async function fileIssues(api, fileIds) {
  const strToFile = {}
  for (const fid of fileIds) {
    for (let offset = 0; offset <= 20000; offset += 500) {
      let b
      try { b = await api(`/projects/${PROJECT}/strings?fileId=${fid}&limit=500&offset=${offset}`) } catch { break }
      const d = (b.data || []).map((x) => x.data)
      for (const s of d) strToFile[s.id] = fid
      if (d.length < 500) break
    }
  }
  const out = {}
  for (const fid of fileIds) out[fid] = { total: 0, byLang: {} }
  for (let offset = 0; offset <= 20000; offset += 500) {
    let b
    try { b = await api(`/projects/${PROJECT}/comments?type=issue&issueStatus=unresolved&limit=500&offset=${offset}`) } catch { break }
    const d = (b.data || []).map((x) => x.data)
    for (const cm of d) {
      const fid = strToFile[cm.stringId]
      if (fid == null) continue
      out[fid].total++
      const lang = cm.languageId || '_source'
      out[fid].byLang[lang] = (out[fid].byLang[lang] || 0) + 1
    }
    if (d.length < 500) break
  }
  return out
}

export async function scanFile(token, ticket, codes) {
  const auth = { Authorization: 'Bearer ' + token }
  const api = async (p) => {
    const r = await fetch(BASE + p, { headers: auth })
    const j = await r.json().catch(() => null)
    if (r.status >= 400) throw new Error(`Crowdin ${p} → ${r.status} ${JSON.stringify(j).slice(0, 160)}`)
    return j
  }
  const isMatch = (f) => f.title === ticket || stripExt(f.name) === ticket
  // fast path: filter by name (dashboard's <ticket>.csv, plugin's <ticket>.xlsx)
  const b = await api(`/projects/${PROJECT}/files?filter=${encodeURIComponent(ticket)}&limit=500`)
  let matches = (b.data || []).map((x) => x.data).filter(isMatch)
  // fallback: full scan so title-only matches (auto-named files) are found too
  if (!matches.length) matches = (await allFiles(api)).filter(isMatch)
  if (!matches.length) return { found: false, files: [] }
  matches.sort((a, b) => (/\.csv$/i.test(b.name) ? 1 : 0) - (/\.csv$/i.test(a.name) ? 1 : 0))   // .csv first
  matches = matches.slice(0, 6)   // safety cap on progress calls

  const pairs = (codes || []).map((c) => ({ code: String(c).toUpperCase(), langId: toCrowdinLang(c) })).filter((p) => p.langId)
  const proj = await projectInfo(api)
  const issues = await fileIssues(api, matches.map((f) => f.id)).catch(() => ({}))
  const files = await Promise.all(matches.map(async (file) => {
    const pr = await api(`/projects/${PROJECT}/files/${file.id}/languages/progress?limit=500`)
    const rows = (pr.data || []).map((x) => x.data)
    const byId = {}; rows.forEach((r) => { byId[r.languageId] = r })
    const fi = issues[file.id] || { total: 0, byLang: {} }
    // Show the card's languages (mapped to Crowdin ids). If none given, show any language that has strings.
    let langs
    if (pairs.length) {
      langs = pairs.map((p) => { const r = byId[p.langId] || {}; return { code: p.code, langId: p.langId, translation: r.translationProgress || 0, approval: r.approvalProgress || 0, issues: fi.byLang[p.langId] || 0, editorUrl: editorUrl(proj, file.id, p.langId) } })
    } else {
      langs = rows.filter((r) => ((r.phrases && r.phrases.total) || 0) > 0).map((r) => ({ code: r.languageId, langId: r.languageId, translation: r.translationProgress || 0, approval: r.approvalProgress || 0, issues: fi.byLang[r.languageId] || 0, editorUrl: editorUrl(proj, file.id, r.languageId) }))
    }
    const n = langs.length || 1
    const overall = {
      translation: Math.round(langs.reduce((a, l) => a + l.translation, 0) / n),
      approval: Math.round(langs.reduce((a, l) => a + l.approval, 0) / n)
    }
    return { fileId: file.id, name: file.name, title: file.title || null, url: editorUrl(proj, file.id), overall, issues: fi.total, langs }
  }))
  return { found: true, files }
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = readCrowdinToken()
  if (!token) { res.status(500).json({ error: 'CROWDIN_TOKEN env var not set' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    if (Array.isArray(body.tickets)) { res.status(200).json(await scanIndex(token, body.tickets)); return }
    const ticket = String(body.ticket || '').trim()
    if (!ticket) { res.status(400).json({ error: 'ticket or tickets required' }); return }
    res.status(200).json(await scanFile(token, ticket, body.codes || []))
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
