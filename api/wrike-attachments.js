// Vercel serverless function (Node): POST /api/wrike-attachments
//   { op:'list', taskId }   -> list a task's Wrike attachments (newest first)
//   { op:'toDrive', taskId, attachmentId, ticket, url(AppsScript), spreadsheetId, tab, parentFolderId }
//       -> download the attachment from Wrike, hand it to the Apps Script which uploads it to a
//          <ticket> subfolder in Drive, shares it (anyone-with-link viewer), and writes the link
//          into the sheet's Context column for every content row.
// The Wrike token stays server-side; the file bytes are relayed server->Apps Script (never the browser).
import { Readable } from 'node:stream'
import { checkAuth } from './wrike-cards.js'

const WAPI = 'https://www.wrike.com/api/v4'

export async function listAttachments(token, taskId) {
  const r = await fetch(`${WAPI}/tasks/${taskId}/attachments`, { headers: { Authorization: 'Bearer ' + token } })
  const j = await r.json().catch(() => null)
  if (r.status >= 400) throw new Error('Wrike attachments → ' + r.status + ' ' + ((j && j.errorDescription) || ''))
  const list = (j.data || []).map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size || 0, createdDate: a.createdDate, author: a.authorId }))
  list.sort((a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || '')))   // newest first
  return { attachments: list }
}

// The file bytes are base64-relayed through this function and the Apps Script, which caps the
// workable size well below Wrike's own limit. Anything larger is handled by creating the folder
// and telling the user to drop the file in by hand.
const OVERSIZE_LIMIT = 35 * 1024 * 1024   // ~35 MB raw (base64 ≈ 47 MB, under Apps Script's ~50 MB)

// Open a streaming download of an attachment from Wrike (bytes are piped straight through to the
// caller, never buffered whole) — used by the download-to-PC proxy, which works at any size.
export async function openAttachmentStream(token, attachmentId) {
  const id = String(attachmentId || '')
  if (!id) throw new Error('attachmentId required')
  const mr = await fetch(`${WAPI}/attachments/${id}`, { headers: { Authorization: 'Bearer ' + token } })
  const mj = await mr.json().catch(() => null)
  const meta = (mj && mj.data && mj.data[0]) || {}
  const dr = await fetch(`${WAPI}/attachments/${id}/download`, { headers: { Authorization: 'Bearer ' + token }, redirect: 'follow' })
  if (dr.status >= 400 || !dr.body) throw new Error('Wrike download → ' + dr.status)
  return { body: dr.body, fileName: meta.name || id, contentType: meta.contentType || 'application/octet-stream', size: Number(meta.size || 0) }
}

export async function attachmentToDrive(token, opts) {
  const attachmentId = String(opts.attachmentId || '')
  const appsScriptUrl = String(opts.appsScriptUrl || opts.url || '')
  if (!attachmentId) throw new Error('attachmentId required')
  if (!/^https:\/\/script\.google\.com\//.test(appsScriptUrl)) throw new Error('invalid Apps Script URL')

  // create (or find) the <ticket> subfolder and return its link — the fallback for big/failed files
  const ensureFolder = async () => {
    try {
      const fr = await fetch(appsScriptUrl, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
        // spreadsheetId is sent only to satisfy the connector's "spreadsheet chosen" guard; ensureFolder ignores it
        body: JSON.stringify({ mode: 'ensureFolder', parentFolderId: String(opts.parentFolderId || ''), ticket: String(opts.ticket || ''), spreadsheetId: String(opts.spreadsheetId || '') })
      })
      const fj = await fr.json().catch(() => null)
      return (fj && fj.ok) ? { folderUrl: fj.url, folderId: fj.folderId } : {}
    } catch { return {} }
  }

  // metadata (name + contentType + size)
  const mr = await fetch(`${WAPI}/attachments/${attachmentId}`, { headers: { Authorization: 'Bearer ' + token } })
  const mj = await mr.json().catch(() => null)
  const meta = (mj && mj.data && mj.data[0]) || {}
  const fileName = meta.name || (String(opts.ticket || 'file'))
  const contentType = meta.contentType || 'application/octet-stream'
  const size = Number(meta.size || opts.size || 0)

  // too big to relay — make the folder and tell the user to add it manually
  if (size > OVERSIZE_LIMIT) {
    const f = await ensureFolder()
    return { ok: true, oversize: true, reason: 'too-big', fileName, size, ...f }
  }

  try {
    // download the bytes
    const dr = await fetch(`${WAPI}/attachments/${attachmentId}/download`, { headers: { Authorization: 'Bearer ' + token }, redirect: 'follow' })
    if (dr.status >= 400) throw new Error('Wrike download → ' + dr.status)
    const buf = Buffer.from(await dr.arrayBuffer())

    // hand to the Apps Script (Drive upload + Context write); its response is readable server-side
    const ar = await fetch(appsScriptUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
      body: JSON.stringify({ mode: 'attachToSheet', spreadsheetId: String(opts.spreadsheetId || ''), tab: String(opts.tab || ''), ticket: String(opts.ticket || ''), parentFolderId: String(opts.parentFolderId || ''), fileName, contentType, dataBase64: buf.toString('base64') })
    })
    const aj = await ar.json().catch(() => null)
    if (!aj || !aj.ok) throw new Error((aj && aj.error) || 'Apps Script upload failed — redeploy it with Drive permission?')
    return { ok: true, url: aj.url, folderId: aj.folderId, fileId: aj.fileId, rows: aj.rows, fileName, size: buf.length }
  } catch (e) {
    // upload failed anyway — still leave the folder ready and report it, don't hard-fail
    const f = await ensureFolder()
    return { ok: true, oversize: true, reason: 'error', error: String((e && e.message) || e), fileName, size, ...f }
  }
}

export default async function handler(req, res) {
  const token = process.env.WRIKE_TOKEN
  // GET = stream an attachment straight to the browser as a download (auth via ?key= because a
  // download navigation can't send the x-access-key header). Same endpoint, kept under the 12-fn cap.
  if (req.method === 'GET') {
    const q = req.query || {}
    const auth = checkAuth(Array.isArray(q.key) ? q.key[0] : q.key)
    if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
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
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }) }
    return
  }
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  if (!token) { res.status(500).json({ error: 'WRIKE_TOKEN env var not set' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    if (body.op === 'toDrive') { res.status(200).json(await attachmentToDrive(token, body)); return }
    const taskId = String(body.taskId || '')
    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return }
    res.status(200).json(await listAttachments(token, taskId))
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
