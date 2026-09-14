// Vercel serverless function (Node): POST /api/crowdin-progress
// Returns { progress: { taskId: percent } } for the given Crowdin task ids.
import { checkAuth } from './wrike-cards.js'
import { readCrowdinToken } from './crowdin-file.js'

const BASE = 'https://api.crowdin.com/api/v2'
const PROJECT = Number(process.env.CROWDIN_PROJECT_ID || 873652)

export async function taskProgress(token, taskIds) {
  const auth = { Authorization: 'Bearer ' + token }
  const out = {}
  const missing = []   // ids that no longer exist in Crowdin (deleted) → dashboard should drop them
  await Promise.all((taskIds || []).map(Number).filter(Boolean).map(async (id) => {
    try {
      const r = await fetch(BASE + `/projects/${PROJECT}/tasks/${id}`, { headers: auth })
      if (r.status === 404) { missing.push(id); return }   // deleted
      const j = await r.json().catch(() => null)
      if (r.ok && j && j.data) out[id] = (j.data.progress && j.data.progress.percent) || 0
    } catch { /* transient error — leave the task in place */ }
  }))
  return { progress: out, missing }
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = readCrowdinToken()
  if (!token) { res.status(500).json({ error: 'CROWDIN_TOKEN env var not set' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    res.status(200).json(await taskProgress(token, body.taskIds || []))
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
