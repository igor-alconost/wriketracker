// Vercel serverless function (Node): POST /api/crowdin-file
// Creates (or updates) a source file in the Crowdin project from a card's Original-content
// strings, and returns the file's editor link. The Crowdin token stays server-side.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAuth } from './wrike-cards.js'

const BASE = 'https://api.crowdin.com/api/v2'
const PROJECT = Number(process.env.CROWDIN_PROJECT_ID || 873652)
const DIR = 'Dashboard'
// the project's target languages (empty columns; Crowdin's CSV importer requires >=1 translation col)
const TARGETS = ['fr', 'es-ES', 'de', 'it', 'ja', 'ko', 'nl', 'pl', 'pt-PT', 'tr', 'zh-CN', 'zh-TW', 'pt-BR', 'es-MX', 'ar-SA']

// Prefer the env var (Vercel); fall back to the crowdin* key in ../../wrike.env for local dev.
export function readCrowdinToken() {
  if (process.env.CROWDIN_TOKEN) return process.env.CROWDIN_TOKEN
  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'wrike.env')
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*[:=]\s*(.+?)\s*$/)
      if (m && /crowdin/i.test(m[1])) return m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* not present on Vercel */ }
  return ''
}

const csvEsc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'
function buildCsv(ticket, strings, context) {
  const cols = ['identifier', 'context', 'source', ...TARGETS]
  const list = (strings && strings.length) ? strings : ['']
  const ctx = context || []
  const rows = [cols.join(',')]
  list.forEach((s, i) => rows.push([csvEsc(ticket + '-' + (i + 1)), csvEsc(ctx[i] || ''), csvEsc(s), ...TARGETS.map(() => csvEsc(''))].join(',')))
  return rows.join('\n') + '\n'
}

export async function upsertCrowdinFile(token, ticket, strings, folder, context) {
  const auth = { Authorization: 'Bearer ' + token }
  const api = async (m, p, obj) => {
    const r = await fetch(BASE + p, { method: m, headers: { ...auth, ...(obj ? { 'Content-Type': 'application/json' } : {}) }, body: obj ? JSON.stringify(obj) : undefined })
    const j = await r.json().catch(() => null)
    if (r.status >= 400) throw new Error(`Crowdin ${m} ${p} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
    return j
  }
  // 1) upload the CSV to storage
  const sres = await fetch(BASE + '/storages', { method: 'POST', headers: { ...auth, 'Crowdin-API-FileName': ticket + '.csv', 'Content-Type': 'text/csv; charset=utf-8' }, body: buildCsv(ticket, strings, context) })
  if (sres.status >= 400) throw new Error('Crowdin storage → ' + sres.status)
  const storageId = (await sres.json()).data.id

  // 2) place it under the existing "Google Sheets/<batch>" folder, the same structure the plugin uses
  const dirName = String(folder || DIR).replace(/[\\/]/g, '-').trim() || DIR
  const dirs = (await api('GET', `/projects/${PROJECT}/directories?limit=500`)).data.map((d) => d.data)
  let gs = dirs.find((d) => d.name === 'Google Sheets' && !d.directoryId && !d.branchId)
  if (!gs) gs = (await api('POST', `/projects/${PROJECT}/directories`, { name: 'Google Sheets' })).data
  let dir = dirs.find((d) => d.name === dirName && d.directoryId === gs.id)
  if (!dir) dir = (await api('POST', `/projects/${PROJECT}/directories`, { name: dirName, directoryId: gs.id })).data

  // 3) create or update <ticket>.csv in that directory
  const name = ticket + '.csv'
  const files = (await api('GET', `/projects/${PROJECT}/files?directoryId=${dir.id}&limit=500`)).data.map((f) => f.data)
  const existing = files.find((f) => f.name === name)
  const scheme = { identifier: 0, context: 1, sourcePhrase: 2 }
  TARGETS.forEach((t, i) => { scheme[t] = 3 + i })
  let fileId, created
  if (existing) {
    await api('PUT', `/projects/${PROJECT}/files/${existing.id}`, { storageId, updateOption: 'keep_translations_and_approvals' })
    fileId = existing.id; created = false
  } else {
    const f = await api('POST', `/projects/${PROJECT}/files`, { storageId, name, title: ticket, directoryId: dir.id, type: 'csv', importOptions: { firstLineContainsHeader: true, importTranslations: false, scheme } })
    fileId = f.data.id; created = true
  }
  // The editor URL needs the project slug (identifier), not the numeric id, to resolve.
  let slug = String(PROJECT)
  try { slug = (await api('GET', `/projects/${PROJECT}`)).data.identifier || slug } catch { /* fall back to id */ }
  return { fileId, created, folder: 'Google Sheets/' + dirName, url: `https://crowdin.com/editor/${slug}/${fileId}/` }
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = readCrowdinToken()
  if (!token) { res.status(500).json({ error: 'CROWDIN_TOKEN env var not set' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const ticket = String(body.ticket || '').trim()
    if (!ticket) { res.status(400).json({ error: 'ticket required' }); return }
    res.status(200).json(await upsertCrowdinFile(token, ticket, body.strings || [], body.folder, body.context || []))
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
