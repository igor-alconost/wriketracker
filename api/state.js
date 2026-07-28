// Vercel serverless function (Node): shared Done / LQA-dismissed state for all users.
// GET  /api/state            -> { done:{}, lqa:{}, trans:{}, lqadone:{} }   (cardId -> ts)
// POST /api/state  body {kind, id, ts}          -> set the flag
//                  body {kind, id, remove:true} -> clear the flag
// kind is one of: 'done' (Done), 'lqa' (LQA-ready pill dismissed),
//                 'trans' (Translation/proofread), 'lqadone' (LQA checkbox),
//                 'tagseen' (cleared the new-tagged-message mark).
// GET also returns tagBaseline: a single shared "tracking start" timestamp (seeded once).
// Backed by Neon (Vercel's Postgres). Same shared-password gate as /api/wrike-cards.
import { neon } from '@neondatabase/serverless'
import { checkAuth } from './wrike-cards.js'

// The Neon/Vercel integration injects DATABASE_URL (older setups used POSTGRES_URL).
let _sql, _ready = false
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL
    if (!url) throw new Error('No database URL — connect Postgres (Neon) to this project')
    _sql = neon(url)
  }
  return _sql
}

async function ensureTable(sql) {
  if (_ready) return
  await sql`CREATE TABLE IF NOT EXISTS bt_state (
    kind TEXT NOT NULL,
    card_id TEXT NOT NULL,
    ts BIGINT NOT NULL,
    PRIMARY KEY (kind, card_id)
  )`
  _ready = true
}

const KINDS = new Set(['done', 'lqa', 'trans', 'lqadone', 'tagseen'])

async function readAll(sql) {
  const rows = await sql`SELECT kind, card_id, ts FROM bt_state`
  const out = { done: {}, lqa: {}, trans: {}, lqadone: {}, tagseen: {} }
  let baseline = null
  for (const r of rows) {
    if (r.kind === 'meta') { if (r.card_id === 'tagBaseline') baseline = Number(r.ts); continue }
    if (!out[r.kind]) out[r.kind] = {}
    out[r.kind][r.card_id] = Number(r.ts)
  }
  out.tagBaseline = baseline
  return out
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  try {
    const sql = db()
    await ensureTable(sql)
    if (req.method === 'GET') {
      // seed the shared "tracking start" baseline once (first ever GET)
      await sql`INSERT INTO bt_state (kind, card_id, ts) VALUES ('meta', 'tagBaseline', ${Date.now()})
                ON CONFLICT (kind, card_id) DO NOTHING`
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).json(await readAll(sql))
      return
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
      const kind = KINDS.has(body.kind) ? body.kind : null
      const id = String(body.id || '')
      if (!kind || !id) { res.status(400).json({ error: 'kind and id required' }); return }
      if (body.remove) {
        await sql`DELETE FROM bt_state WHERE kind=${kind} AND card_id=${id}`
      } else {
        const ts = Number(body.ts) || Date.now()
        await sql`INSERT INTO bt_state (kind, card_id, ts) VALUES (${kind}, ${id}, ${ts})
                  ON CONFLICT (kind, card_id) DO UPDATE SET ts = EXCLUDED.ts`
      }
      res.status(200).json(await readAll(sql))
      return
    }
    res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
