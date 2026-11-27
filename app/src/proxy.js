// WebSocket <-> TCP bridge for the in-browser client (same protocol as prismarinejs-net-browserify),
// locked down: it only connects to running showcase world servers, addressed as "sc-<showcase id>".
const net = require('net')
const crypto = require('crypto')
const express = require('express')
const { WebSocketServer } = require('ws')

function createProxy ({ resolveShowcase, root = '/api/vm/net' }) {
  const router = express.Router()
  const sockets = new Map()   // token -> tcp socket (waiting for its websocket)
  router.get(root + '/connect', (req, res) => res.json({ code: 200, description: 'Showcase proxy', time: Date.now() }))
  router.post(root + '/connect', express.json({ limit: '2kb' }), async (req, res) => {
    const host = String(req.body?.host || '')
    const m = /^(city|sc-[a-z0-9-]{1,64})$/.exec(host)
    if (!m) return res.status(403).send({ code: 403, error: 'Only the Blockprint city can be reached here' })
    let port
    try { port = await resolveShowcase(m[1]) } catch (e) { return res.status(404).send({ code: 404, error: String(e.message || e) }) }
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 15000 }, () => {
      const token = crypto.randomBytes(24).toString('hex')
      sockets.set(token, socket)
      socket.removeAllListeners('timeout')
      setTimeout(() => { if (sockets.get(token) === socket) { sockets.delete(token); socket.destroy() } }, 30000) // must be claimed quickly
      res.send({ token, remote: { address: host, port: 25565, family: 'IPv4' } })
    })
    socket.on('timeout', () => { if (!res.headersSent) res.status(504).send({ code: 504, error: 'World server did not answer' }); socket.destroy() })
    socket.on('error', err => { if (!res.headersSent) res.status(502).send({ code: 502, error: 'World server error: ' + err.code }) })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  function handleUpgrade (req, sock, head) {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === root + '/ping') {
      return wss.handleUpgrade(req, sock, head, ws => ws.on('message', d => { const s = d.toString(); if (s.startsWith('ping:')) ws.send('pong:' + s.slice(5)) }))
    }
    if (url.pathname !== root + '/socket') return false
    const token = url.searchParams.get('token')
    const tcp = sockets.get(token)
    if (!tcp) { sock.destroy(); return true }
    sockets.delete(token)
    wss.handleUpgrade(req, sock, head, ws => {
      tcp.setTimeout(0)
      ws.on('message', (data, isBinary) => {
        if (!isBinary) { const s = data.toString(); if (s.startsWith('ping:')) { ws.send('pong:' + s.slice(5)); return } }
        tcp.write(data)
      })
      tcp.on('data', chunk => { if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true }) })
      tcp.on('close', () => { try { ws.send('proxy-shutdown:Minecraft server closed the connection.') } catch {} ws.close() })
      tcp.on('error', () => ws.close())
      ws.on('close', () => tcp.end())
      ws.on('error', () => tcp.destroy())
    })
    return true
  }
  return { router, handleUpgrade }
}

module.exports = { createProxy }
