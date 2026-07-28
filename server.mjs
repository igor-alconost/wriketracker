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

    // Shared Done / LQA state — local dev mirror of the Vercel Postgres-backed /api/state.
    // Stored in a JSON file so it persists across restarts on this machine.
    if (url.pathname === '/api/state') {
      const auth = checkAuth(req.headers['x-access-key'])
      if (!auth.ok) { res.writeHead(auth.code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: auth.error })); return }
      const STATE_FILE = path.join(ROOT, '.state.json')
      const KINDS = ['done', 'lqa', 'trans', 'lqadone', 'tagseen']
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
            if (body.remove) delete s[kind][String(body.id)]; else s[kind][String(body.id)] = Number(body.ts) || Date.now()
            fs.writeFileSync(STATE_FILE, JSON.stringify(s))
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s))
          } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
        })
        return
      }
      res.writeHead(405); res.end(); return
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
