// Vercel serverless function (Node): POST /api/wrike-attachments
//   { op:'list', taskId }   -> list a task's Wrike attachments (newest first)
//   { op:'toDrive', taskId, attachmentId, ticket, url(AppsScript), spreadsheetId, tab, parentFolderId }
//       -> download the attachment from Wrike, hand it to the Apps Script which uploads it to a
//          <ticket> subfolder in Drive, shares it (anyone-with-link viewer), and writes the link
//          into the sheet's Context column for every content row.
// The Wrike token stays server-side; the file bytes are relayed server->Apps Script (never the browser).
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

export async function attachmentToDrive(token, opts) {
  const attachmentId = String(opts.attachmentId || '')
  const appsScriptUrl = String(opts.appsScriptUrl || opts.url || '')
  if (!attachmentId) throw new Error('attachmentId required')
  if (!/^https:\/\/script\.google\.com\//.test(appsScriptUrl)) throw new Error('invalid Apps Script URL')

  // metadata (name + contentType)
  const mr = await fetch(`${WAPI}/attachments/${attachmentId}`, { headers: { Authorization: 'Bearer ' + token } })
  const mj = await mr.json().catch(() => null)
  const meta = (mj && mj.data && mj.data[0]) || {}
  const fileName = meta.name || (String(opts.ticket || 'file'))
  const contentType = meta.contentType || 'application/octet-stream'

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
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  const token = process.env.WRIKE_TOKEN
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
