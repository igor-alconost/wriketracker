// Local server for the Brief Tracker.
// Run:  node server.mjs   →  http://localhost:5178
// Serves the dashboard and exposes GET /api/refresh, which re-pulls from
// Wrike and rewrites data.js. The token stays here on the server, never
// in the browser.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshData, readToken } from './refresh.mjs'
import { buildCards, checkAuth } from './api/wrike-cards.js'
import { upsertCrowdinFile, readCrowdinToken } from './api/crowdin-file.js'
import { createTasks } from './api/crowdin-tasks.js'
import { taskProgress } from './api/crowdin-progress.js'
import { fetchTranslations } from './api/crowdin-translations.js'
import { listTabs, readSource } from './api/sheet-tabs.js'
import { scanFile, scanIndex } from './api/crowdin-scan.js'
import { listAttachments, attachmentToDrive } from './api/wrike-attachments.js'
import { createLqaReport } from './api/lqa-report.js'
import { createAlphas, readAlconostKey, listManagers } from './api/alconost-alpha.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 5178

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    // Same endpoint the hosted (Vercel) app uses: returns live cards as JSON.
    if (url.pathname === '/api/wrike-cards') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      try {
        const data = await buildCards(readToken(), Number(process.env.LOOKBACK_DAYS || '30'))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(data))
      } catch (e) {
        console.error(e)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e.message || e) }))
      }
      return
    }

    // Create/update a Crowdin source file from a card (mirrors the Vercel /api/crowdin-file).
    if (url.pathname === '/api/crowdin-file') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let raw = ''; req.on('data', (d) => { raw += d })
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw || '{}')
          const token = readCrowdinToken()
          if (!token) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Crowdin token not set' })); return }
          const result = await upsertCrowdinFile(token, String(body.ticket || '').trim(), body.strings || [], body.folder)
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result))
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
      })
      return
    }

    // Create Crowdin tasks / read task progress / fetch translations / list sheet tabs (mirror Vercel).
    if (url.pathname === '/api/crowdin-tasks' || url.pathname === '/api/crowdin-progress' || url.pathname === '/api/crowdin-translations' || url.pathname === '/api/sheet-tabs' || url.pathname === '/api/crowdin-scan') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let raw = ''; req.on('data', (d) => { raw += d })
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw || '{}')
          const token = readCrowdinToken()
          if (!token) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Crowdin token not set' })); return }
          let out
          if (url.pathname === '/api/crowdin-tasks') out = { tasks: await createTasks(token, { fileId: body.fileId, title: String(body.title || ''), codes: body.codes || [], type: body.type === 1 ? 1 : 0, skipAssigned: !!body.skipAssigned }) }
          else if (url.pathname === '/api/crowdin-translations') out = await fetchTranslations(token, Number(body.fileId), body.codes || [])
          else if (url.pathname === '/api/sheet-tabs') out = (body.op === 'readSource') ? await readSource(String(body.url || ''), body.id, body.tab) : await listTabs(String(body.url || ''), body.ids || [])
          else if (url.pathname === '/api/crowdin-scan') out = Array.isArray(body.tickets) ? await scanIndex(token, body.tickets) : await scanFile(token, String(body.ticket || ''), body.codes || [])
          else out = await taskProgress(token, body.taskIds || [])
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out))
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
      })
      return
    }

    // List the configured Alconost managers (names only — keys stay server-side).
    if (url.pathname === '/api/managers') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ managers: listManagers() }))
      return
    }

    // Create alphas in Alconost's internal app (mirror of Vercel /api/alconost-alpha).
    if (url.pathname === '/api/alconost-alpha') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let raw = ''; req.on('data', (d) => { raw += d })
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw || '{}')
          const key = readAlconostKey(body.manager)
          if (!key) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No Alconost API key for manager "' + (body.manager || 'default') + '"' })); return }
          const results = await createAlphas(key, body.items || [])
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ results }))
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
      })
      return
    }

    // Shared Done / LQA state — local dev mirror of the Vercel Postgres-backed /api/state.
    // Stored in a JSON file so it persists across restarts on this machine.
    if (url.pathname === '/api/state') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      const STATE_FILE = path.join(ROOT, '.state.json')
      const KINDS = ['done', 'lqa', 'trans', 'lqadone', 'tagseen', 'deleted', 'crtasks', 'sheettab', 'linguists', 'appsurl', 'feedback']
      const readState = () => {
        let s; try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { s = {} }
        for (const k of KINDS) s[k] = s[k] || {}
        return s
      }
      if (req.method === 'GET') {
        const s = readState()
        if (s.tagBaseline == null) { s.tagBaseline = Date.now(); fs.writeFileSync(STATE_FILE, JSON.stringify(s)) }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(s)); return
      }
      if (req.method === 'POST') {
        let raw = ''; req.on('data', (d) => { raw += d })
        req.on('end', () => {
          try {
            const body = JSON.parse(raw || '{}')
            const kind = KINDS.includes(body.kind) ? body.kind : null
            if (!kind || !body.id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'kind and id required' })); return }
            const s = readState()
            if (body.remove) delete s[kind][String(body.id)]
            else s[kind][String(body.id)] = (body.val !== undefined && body.val !== null && body.val !== '') ? String(body.val) : (Number(body.ts) || Date.now())
            fs.writeFileSync(STATE_FILE, JSON.stringify(s))
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s))
          } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
        })
        return
      }
      res.writeHead(405); res.end(); return
    }

    // Wrike attachments: list a card's attachments, or push one to Drive + write the Context column.
    if (url.pathname === '/api/wrike-attachments') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let raw = ''; req.on('data', (d) => { raw += d })
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw || '{}')
          const token = readToken()
          const out = (body.op === 'toDrive') ? await attachmentToDrive(token, body) : await listAttachments(token, String(body.taskId || ''))
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out))
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
      })
      return
    }

    // Create the LQA Report spreadsheet (proxied to the Apps Script).
    if (url.pathname === '/api/lqa-report') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let raw = ''; req.on('data', (d) => { raw += d })
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw || '{}')
          const out = await createLqaReport(String(body.url || ''), body)
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out))
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
      })
      return
    }

    if (url.pathname === '/api/refresh') {
      try {
        const result = await refreshData((m) => console.log('[refresh]', m))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (e) {
        console.error(e)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      }
      return
    }

    let file = url.pathname === '/' ? '/index.html' : url.pathname
    const full = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ''))
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' })
      res.end(data)
    })
  })
  .listen(PORT, () => {
    console.log(`Brief Tracker running at http://localhost:${PORT}`)
    console.log('The Refresh button will re-pull live data from Wrike.')
  })
