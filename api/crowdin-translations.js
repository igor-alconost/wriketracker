// Vercel serverless function (Node): POST /api/crowdin-translations
// Fetches the latest translations for a Crowdin file's strings, keyed back to the sheet's
// language codes and row numbers, so the dashboard can push them into the spreadsheet.
import { checkAuth } from './wrike-cards.js'
import { readCrowdinToken } from './crowdin-file.js'
import { toCrowdinLang } from './crowdin-tasks.js'

const BASE = 'https://api.crowdin.com/api/v2'
const PROJECT = Number(process.env.CROWDIN_PROJECT_ID || 873652)

export async function fetchTranslations(token, fileId, codes) {
  const auth = { Authorization: 'Bearer ' + token }
  const api = async (p) => {
    const r = await fetch(BASE + p, { headers: auth })
    const j = await r.json().catch(() => null)
    if (r.status >= 400) throw new Error(`Crowdin ${p} → ${r.status} ${JSON.stringify(j).slice(0, 160)}`)
    return j
  }
  // 1) source strings for the file (paged)
  let strings = []; let offset = 0
  while (true) {
    const b = await api(`/projects/${PROJECT}/strings?fileId=${fileId}&limit=500&offset=${offset}`)
    const d = (b.data || []).map((x) => x.data); strings = strings.concat(d)
    if (d.length < 500) break; offset += 500
  }
  const idList = strings.map((s) => s.id)
  if (!idList.length) return { rows: [], strings: 0 }

  // 2) latest translations per language (Scopely code -> Crowdin id), keyed by the original code
  const pairs = (codes || []).map((c) => ({ code: String(c).toUpperCase(), langId: toCrowdinLang(c) })).filter((p) => p.langId)
  const transByCode = {}
  await Promise.all(pairs.map(async (p) => {
    const map = {}; let off = 0
    while (true) {
      let d = []
      try {
        const b = await api(`/projects/${PROJECT}/languages/${p.langId}/translations?stringIds=${idList.join(',')}&limit=500&offset=${off}`)
        d = (b.data || []).map((x) => x.data)
      } catch { d = [] }
      for (const t of d) if (t.text != null) map[t.stringId] = t.text
      if (d.length < 500) break; off += 500
    }
    transByCode[p.code] = map
  }))

  // 3) build rows: row number from the "<ticket>-<n>" identifier (else source order)
  const rows = strings.map((s, i) => {
    let n = i + 1
    const m = String(s.identifier || '').match(/-(\d+)$/); if (m) n = Number(m[1])
    const cells = {}
    for (const p of pairs) { const txt = transByCode[p.code] && transByCode[p.code][s.id]; if (txt != null && txt !== '') cells[p.code] = txt }
    return { n, source: s.text, cells }
  })
  return { rows, strings: strings.length }
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = readCrowdinToken()
  if (!token) { res.status(500).json({ error: 'CROWDIN_TOKEN env var not set' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const fileId = Number(body.fileId)
    if (!fileId) { res.status(400).json({ error: 'fileId required' }); return }
    res.status(200).json(await fetchTranslations(token, fileId, body.codes || []))
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
