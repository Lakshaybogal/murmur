// Tiny local web UI for one ChatNode. Only listens on 127.0.0.1: the "server" is just your own browser talking to your own node.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html'))

export function startUi(node, port) {
  const clients = new Set()
  node.on('change', (groupId) => { for (const r of clients) r.write(`data: ${JSON.stringify({ groupId })}\n\n`) })

  const body = (req) => new Promise((resolve) => {
    let s = ''
    req.on('data', (d) => { s += d; if (s.length > 1e5) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })
  const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }

  const server = http.createServer(async (req, res) => {
    // block other websites from poking your local node
    const host = req.headers.host || ''
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return json(res, 403, { error: 'bad host' })
    if (req.headers.origin && new URL(req.headers.origin).host !== host) return json(res, 403, { error: 'bad origin' })

    const url = new URL(req.url, 'http://x')
    try {
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html) }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { me: { name: node.name, id: node.userId }, groups: node.listGroups() })
      if (req.method === 'GET' && url.pathname === '/api/messages') return json(res, 200, node.messages(url.searchParams.get('g')))
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write('\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
      }
      if (req.method === 'POST') {
        const b = await body(req)
        if (url.pathname === '/api/create') return json(res, 200, await node.createGroup(String(b.label || '').slice(0, 40)).then((g) => ({ id: g.id })))
        if (url.pathname === '/api/join') return json(res, 200, await node.joinGroup(String(b.id || ''), String(b.label || '').slice(0, 40)).then((g) => ({ id: g.id })))
        if (url.pathname === '/api/send') { node.send(b.g, b.text); return json(res, 200, { ok: true }) }
      }
      json(res, 404, { error: 'not found' })
    } catch (e) { json(res, 400, { error: e.message }) }
  })

  return new Promise((resolve, reject) => {
    const listen = (p) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' ? listen(p + 1) : reject(e)))
      server.listen(p, '127.0.0.1', () => resolve(p))
    }
    listen(port)
  })
}
