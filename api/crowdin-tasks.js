// Vercel serverless function (Node): POST /api/crowdin-tasks
// Creates Crowdin tasks (one per language) for a file — type 0 = translate, 1 = proofread.
// Maps the dashboard's Scopely language codes to Crowdin ids and skips EN-AU / non-targets.
import { checkAuth } from './wrike-cards.js'
import { readCrowdinToken } from './crowdin-file.js'

const BASE = 'https://api.crowdin.com/api/v2'
const PROJECT = Number(process.env.CROWDIN_PROJECT_ID || 873652)
const TARGETS = new Set(['fr', 'es-ES', 'de', 'it', 'ja', 'ko', 'nl', 'pl', 'pt-PT', 'tr', 'zh-CN', 'zh-TW', 'pt-BR', 'es-MX', 'ar-SA'])
// Scopely/client code -> Crowdin language id (EN-AU is intentionally excluded)
const LANGMAP = { JP: 'ja', CHT: 'zh-TW', CHS: 'zh-CN', AR: 'ar-SA', 'FR-FR': 'fr', 'ES-ES': 'es-ES', 'PT-PT': 'pt-PT', DE: 'de', IT: 'it', KO: 'ko', NL: 'nl', PL: 'pl', TR: 'tr', 'EN-AU': null }
export function toCrowdinLang(code) {
  const c = String(code || '').toUpperCase()
  if (c === 'EN-AU') return null
  const id = Object.prototype.hasOwnProperty.call(LANGMAP, c) ? LANGMAP[c] : c.toLowerCase()
  return id && TARGETS.has(id) ? id : null
}

// Existing tasks on this file, so we never create a duplicate for the same string set.
// Crowdin's REST doesn't expose a task's string list, but our titles encode the set
// (card title = whole file; "New strings…"/"#N New strings…" = that batch), so a match on
// file + language + title + type means "same strings already tasked".
async function listFileTasks(auth, fileId) {
  const out = []
  for (let offset = 0; ; offset += 500) {
    const r = await fetch(BASE + `/projects/${PROJECT}/tasks?limit=500&offset=${offset}`, { headers: auth })
    const j = await r.json().catch(() => null)
    if (r.status >= 400) break
    const d = (j.data || []).map((x) => x.data)
    for (const t of d) if (Array.isArray(t.fileIds) && t.fileIds.map(Number).includes(Number(fileId))) out.push(t)
    if (d.length < 500) break
  }
  return out
}

export async function createTasks(token, { fileId, title, codes, type, skipAssigned }) {
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  const wantTitle = String(title).trim()
  let existing = []
  try { existing = await listFileTasks(auth, fileId) } catch { existing = [] }
  const dupFor = (langId) => existing.find((t) => String(t.languageId) === String(langId) && Number(t.type) === Number(type) && String(t.title || '').trim() === wantTitle)
  const mk = async (code) => {
    const langId = toCrowdinLang(code)
    if (!langId) return null   // EN-AU / unmapped / not a project target
    // Same strings already tasked (same file+language+title+type) → reuse it, don't duplicate.
    const dup = dupFor(langId)
    if (dup) return { code, langId, taskId: dup.id, url: dup.webUrl, percent: (dup.progress && dup.progress.percent) || 0, skipped: 'exists' }
    // skipAssignedStrings: only include strings not already covered by an existing task —
    // i.e. exactly the newly-added rows, so re-uploads spawn tasks for just the new strings.
    const taskBody = { title, languageId: langId, type, fileIds: [Number(fileId)] }
    if (skipAssigned) taskBody.skipAssignedStrings = true
    const r = await fetch(BASE + `/projects/${PROJECT}/tasks`, { method: 'POST', headers: auth, body: JSON.stringify(taskBody) })
    const j = await r.json().catch(() => null)
    if (r.status >= 400) {
      const msg = (j && j.error && j.error.message) || (j && j.errors && JSON.stringify(j.errors)) || ('HTTP ' + r.status)
      return { code, langId, error: msg }
    }
    const t = j.data
    return { code, langId, taskId: t.id, url: t.webUrl, percent: (t.progress && t.progress.percent) || 0 }
  }
  const results = await Promise.all((codes || []).map(mk))
  return results.filter(Boolean)
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = readCrowdinToken()
  if (!token) { res.status(500).json({ error: 'CROWDIN_TOKEN env var not set' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    if (!body.fileId || !body.title) { res.status(400).json({ error: 'fileId and title required' }); return }
    const type = body.type === 1 ? 1 : 0
    const tasks = await createTasks(token, { fileId: body.fileId, title: String(body.title), codes: body.codes || [], type, skipAssigned: !!body.skipAssigned })
    res.status(200).json({ tasks })
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
