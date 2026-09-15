// Vercel serverless function (Node): POST /api/sheet-tabs
// Proxies to the dashboard's Apps Script web app (server-side, so no browser CORS) to list the
// tab names in each spreadsheet, so the dashboard can tell which cards already have a sheet tab.
import { checkAuth } from './wrike-cards.js'

export async function listTabs(url, ids) {
  if (!/^https:\/\/script\.google\.com\//.test(String(url || ''))) return { tabs: {}, needsRedeploy: false }
  // Read-only capability probe (GET → doGet). If the deployed script doesn't support listTabs,
  // don't send it any POST — an old deployment would treat an unknown mode as a create-tab request.
  let caps = []
  try {
    const g = await fetch(url, { method: 'GET', redirect: 'follow' })
    const gj = await g.json().catch(() => null)
    caps = (gj && gj.capabilities) || []
  } catch { /* unreachable */ }
  if (!caps.includes('listTabs')) return { tabs: {}, needsRedeploy: true }

  const out = {}
  await Promise.all((ids || []).map(String).filter(Boolean).map(async (id) => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ mode: 'listTabs', spreadsheetId: id, ip: '' }), redirect: 'follow' })
      const j = await r.json().catch(() => null)
      if (j && j.ok && Array.isArray(j.tabs)) out[id] = j.tabs
    } catch { /* skip this spreadsheet */ }
  }))
  return { tabs: out }
}

// Read the "Original content" column of one tab (the → Crowdin source of truth).
export async function readSource(url, id, tab) {
  if (!/^https:\/\/script\.google\.com\//.test(String(url || ''))) return { strings: [], error: 'invalid Apps Script URL' }
  let caps = []
  try {
    const g = await fetch(url, { method: 'GET', redirect: 'follow' })
    const gj = await g.json().catch(() => null)
    caps = (gj && gj.capabilities) || []
  } catch { /* unreachable */ }
  if (!caps.includes('readSource')) return { strings: [], needsRedeploy: true }
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ mode: 'readSource', spreadsheetId: String(id), tab: String(tab), ip: '' }), redirect: 'follow' })
    const j = await r.json().catch(() => null)
    if (!j || !j.ok) return { strings: [], error: (j && j.error) || 'read failed' }
    // carry the per-row Context column through (the Drive link), used as the Crowdin string context
    return { strings: Array.isArray(j.strings) ? j.strings : [], context: Array.isArray(j.context) ? j.context : [] }
  } catch (e) { return { strings: [], error: String((e && e.message) || e) } }
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const url = String(body.url || '')
    if (!/^https:\/\/script\.google\.com\//.test(url)) { res.status(400).json({ error: 'invalid Apps Script URL' }); return }
    if (body.op === 'readSource') { res.status(200).json(await readSource(url, body.id, body.tab)); return }
    res.status(200).json(await listTabs(url, body.ids || []))
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
