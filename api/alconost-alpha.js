// Vercel serverless function (Node): POST /api/alconost-alpha
// Creates "alphas" in Alconost's internal app (services.app.alconost.com/mcp) — one per Crowdin
// task — via its MCP endpoint (JSON-RPC 2.0 over HTTP). The API key stays server-side.
//
// The MCP server is stateful: initialize returns an Mcp-Session-Id that must be echoed on every
// later call, and a notifications/initialized must be sent before tools/call. create_alpha takes
// camelCase string args; required: customerId, projectName, description, service, source, target,
// volume, execId. There is NO delete_alpha/update_alpha tool — creation is irreversible.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAuth } from './wrike-cards.js'

const MCP_URL = 'https://services.app.alconost.com/mcp'
const CUSTOMER_ID = 'scopely'
const PROJECT_NAME = 'monopoly go'   // create_alpha resolves the project by NAME, not the id 2053
const SERVICE = 'min'
const SOURCE = 'en'
const VOLUME = '1'
const CURRENCY = 'EUR'

// Preferred linguists (execId per language, per stage) live in the shared state store and are
// edited in the dashboard's "Linguists" table. The client sends the resolved execId per item;
// create_alpha REQUIRES a real translator, so an empty execId means "skip this alpha".

// Scopely/client code -> Alconost app target code (its own lowercase scheme, e.g. AR->ar, CHT->zh-tw).
const ALPHA_LANG = {
  JP: 'ja', CHT: 'zh-tw', CHS: 'zh-cn', AR: 'ar', 'FR-FR': 'fr', 'ES-ES': 'es-es', 'ES-MX': 'es-mx',
  'PT-PT': 'pt-pt', 'PT-BR': 'pt-br', DE: 'de', IT: 'it', KO: 'ko', NL: 'nl', PL: 'pl', TR: 'tr', 'EN-AU': 'en-au'
}
export function toAlphaLang(code) {
  const c = String(code || '').toUpperCase()
  if (Object.prototype.hasOwnProperty.call(ALPHA_LANG, c)) return ALPHA_LANG[c]
  return c ? c.toLowerCase() : ''
}

// Per-manager Alconost keys. An alpha's manager = whoever's API key creates it, so each manager
// has their own key. Sources (Vercel env first, then ../../wrike.env for local dev):
//   ALCONOST_API_KEY / alconostapi            -> manager "igor" (the default)
//   ALCONOST_API_KEY_DASHA / alconostapi_dasha -> manager "dasha"
//   …_<NAME> / alconostapi_<name>              -> manager "<name>"
function managerKeys() {
  const out = {}   // name(lower) -> ak_ key
  if (process.env.ALCONOST_API_KEY) out.igor = String(process.env.ALCONOST_API_KEY).trim()
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^ALCONOST_API_KEY_(.+)$/i.exec(k)
    if (m && v) out[m[1].toLowerCase()] = String(v).trim()
  }
  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'wrike.env')
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*alconostapi(?:[_-]([A-Za-z0-9]+))?\s*[:=]\s*(.+?)\s*$/i)
      if (!m) continue
      const name = (m[1] ? m[1] : 'igor').toLowerCase()
      if (!out[name]) out[name] = m[2].replace(/^["']|["']$/g, '').trim()   // env vars win
    }
  } catch { /* not present on Vercel */ }
  return out
}
export function listManagers() { return Object.keys(managerKeys()).sort() }
export function readAlconostKey(manager) {
  const keys = managerKeys()
  const m = String(manager || '').toLowerCase().trim()
  if (m && keys[m]) return keys[m]
  return keys.igor || Object.values(keys)[0] || ''   // default: igor, else any configured key
}

// A tool result can come back as plain JSON or SSE-framed ("data: {…}" lines) — handle both.
function parseBody(t) {
  t = String(t || '').trim()
  if (/^event:|^data:/m.test(t)) t = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
  try { return JSON.parse(t) } catch { return {} }
}

// Open an MCP session and return a call(name, args) helper.
async function mcpSession(key) {
  const headers = { 'X-API-Key': key, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const init = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'brief-tracker', version: '1.0' } } }) })
  if (init.status === 401) throw new Error('Alconost API key rejected (401)')
  const sid = init.headers.get('mcp-session-id') || ''
  const h2 = sid ? { ...headers, 'Mcp-Session-Id': sid } : headers
  await fetch(MCP_URL, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  let id = 1
  const call = async (name, args) => {
    const r = await fetch(MCP_URL, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) })
    const j = parseBody(await r.text())
    if (j.error) throw new Error((j.error && j.error.message) || JSON.stringify(j.error))
    const res = j.result || {}
    const text = (res.content && res.content[0] && res.content[0].text) || ''
    let data; try { data = JSON.parse(text) } catch { data = text }
    if (res.isError) throw new Error(typeof data === 'string' ? data : JSON.stringify(data))
    return data
  }
  return { call }
}

// This MCP server returns tool errors as plain text in content (WITHOUT result.isError),
// e.g. `NOT_FOUND: Cannot load record …` or `Error: execId is required`. Detect those.
function looksLikeError(text) {
  return /^\s*"?(NOT_FOUND|INVALID[_A-Z]*|ERROR|Error|FAILED[_A-Z]*)\b|is required|Cannot load record/.test(String(text || ''))
}

// items: [{ url (Crowdin task link), code (Scopely lang), description, stage }]
// stage selects the linguist column in the shared table (translation | proofreading | lqa).
export async function createAlphas(key, items) {
  const { call } = await mcpSession(key)
  const out = []
  for (const it of (items || [])) {
    const target = toAlphaLang(it.code)
    if (!target) { out.push({ code: it.code, skipped: 'no-target' }); continue }
    const stage = String(it.stage || 'translation')
    const execId = String(it.execId || '')
    if (!execId) { out.push({ code: it.code, target, stage, skipped: 'no-linguist' }); continue }
    const args = {
      customerId: CUSTOMER_ID, projectName: PROJECT_NAME, projectUrl: String(it.url || ''),
      description: String(it.description || ''), service: SERVICE, source: SOURCE, target, volume: VOLUME, execId, currency: CURRENCY
    }
    if (it.tags) args.tags = String(it.tags)   // space-separated hashtags, e.g. "#MPY-83617 #loc"
    try {
      const d = await call('create_alpha', args)
      const asText = (typeof d === 'string') ? d : JSON.stringify(d || '')
      if (looksLikeError(asText)) { out.push({ code: it.code, target, stage, execId, error: (typeof d === 'string' ? d : asText).slice(0, 200) }); continue }
      let alphaId = (d && typeof d === 'object' && (d.id || d.alphaId || (d.alpha && d.alpha.id))) || null
      if (!alphaId) { const m = asText.match(/alpha\d+/i); if (m) alphaId = m[0] }
      out.push({ code: it.code, target, stage, execId, alphaId, ok: true })
    } catch (e) {
      out.push({ code: it.code, target, stage, execId, error: String((e && e.message) || e) })
    }
  }
  return out
}

export default async function handler(req, res) {
  const auth = checkAuth(req.headers['x-access-key'])
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const key = readAlconostKey(body.manager)
    if (!key) { res.status(500).json({ error: 'No Alconost API key for manager "' + (body.manager || 'default') + '"' }); return }
    res.status(200).json({ results: await createAlphas(key, body.items || []) })
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) })
  }
}
