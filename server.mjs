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

    // Public Supabase config for the login screen (mirrors /api/config on Vercel).
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '', authEnabled: !!process.env.SUPABASE_URL }))
      return
    }

    // Same endpoint the hosted (Vercel) app uses: returns live cards as JSON.
    if (url.pathname === '/api/wrike-cards') {
      const auth = await checkAuth(req.headers['authorization'])
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

    let file = url.pathname === '/' ? '/brief-tracker.html' : url.pathname
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
