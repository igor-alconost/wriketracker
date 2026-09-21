// Vercel serverless function (Node): GET /api/wrike-download?att=<id>&key=<access-key>
// Streams a Wrike attachment straight to the browser as a download (Content-Disposition:
// attachment), at any size — the bytes are piped through, never buffered whole. This is the
// "download to PC" path for files too big for the Drive relay.
// A GET (not POST) so the browser can trigger it as a plain download; the access key rides in the
// query because a download navigation can't send the x-access-key header.
import { Readable } from 'node:stream'
import { checkAuth } from './wrike-cards.js'
import { openAttachmentStream } from './wrike-attachments.js'

export default async function handler(req, res) {
  const q = req.query || {}
  const auth = checkAuth(Array.isArray(q.key) ? q.key[0] : q.key)
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = process.env.WRIKE_TOKEN
  if (!token) { res.status(500).json({ error: 'WRIKE_TOKEN env var not set' }); return }
  const att = Array.isArray(q.att) ? q.att[0] : q.att
  if (!att) { res.status(400).json({ error: 'att required' }); return }
  try {
    const { body, fileName, contentType } = await openAttachmentStream(token, att)
    const safe = String(fileName).replace(/["\\\r\n]/g, '_')
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`)
    res.setHeader('Cache-Control', 'no-store')
    Readable.fromWeb(body).pipe(res)
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
