// Vercel serverless function (Node): GET /api/managers
// Returns the configured Alconost manager names (from per-manager keys). Keys stay server-side.
import { checkAuth } from './wrike-cards.js'
import { listManagers } from './alconost-alpha.js'

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({ managers: listManagers() })
}
