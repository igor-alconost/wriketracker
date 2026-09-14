// Vercel serverless function (Node): POST /api/lqa-report
// Proxies to the Apps Script (server-side, so its response is readable) to create the LQA Report
// spreadsheet in a Drive folder — one tab per language, shared "anyone with link — editor".
import { checkAuth } from './wrike-cards.js'

export async function createLqaReport(appsScriptUrl, opts) {
  if (!/^https:\/\/script\.google\.com\//.test(String(appsScriptUrl || ''))) throw new Error('invalid Apps Script URL')
  const r = await fetch(appsScriptUrl, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
    body: JSON.stringify({ mode: 'lqaReport', parentFolderId: String(opts.parentFolderId || ''), name: String(opts.name || ''), langs: opts.langs || [], assetsUrl: String(opts.assetsUrl || '') })
  })
  const j = await r.json().catch(() => null)
  if (!j || !j.ok) throw new Error((j && j.error) || 'Apps Script LQA report failed — redeploy it with Drive permission?')
  return { ok: true, url: j.url, id: j.id, accessible: j.accessible, moved: j.moved, shared: j.shared, note: j.note }
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    res.status(200).json(await createLqaReport(String(body.url || ''), body))
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
