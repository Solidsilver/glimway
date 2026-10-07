/**
 * Playtest routing for the shared Vite dev server (GLIMWAY_E2E_ROUTING=1,
 * set by playwright.config.ts). Every Playwright worker runs its own Go
 * server (e2e/server/backend.ts); the browser contexts of a worker carry the
 * `fs-e2e-api=<port>` cookie, and this plugin sends /api requests and the /ws
 * socket to 127.0.0.1:<port>. The Host header is passed through unchanged, as
 * Vite's own proxy does with changeOrigin off (the server checks Origin).
 *
 * Plain JavaScript so vite.config.ts can load it without Node types.
 */
import http from 'node:http'
import net from 'node:net'

const COOKIE = /(?:^|;\s*)fs-e2e-api=(\d{2,5})(?:;|$)/

/** @param {import('node:http').IncomingMessage} req */
function portOf(req) {
  const m = COOKIE.exec(req.headers.cookie ?? '')
  return m ? Number(m[1]) : null
}

/** @returns {import('vite').Plugin} */
export default function e2eRouting() {
  return {
    name: 'glimway-e2e-routing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url !== '/api' && !url.startsWith('/api/') && !url.startsWith('/api?')) return next()
        const port = portOf(req)
        if (!port) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('glimway e2e routing: no fs-e2e-api cookie on this request (is the test missing test.use({ server: true })?)')
          return
        }
        const upstream = http.request(
          { host: '127.0.0.1', port, method: req.method, path: url, headers: req.headers },
          (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders)
            answer.pipe(res)
          }
        )
        upstream.on('error', (e) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(`glimway e2e routing: ${e.message}`)
        })
        req.pipe(upstream)
      })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!(req.url ?? '').startsWith('/ws')) return
        const port = portOf(req)
        if (!port) {
          socket.destroy()
          return
        }
        const upstream = net.connect(port, '127.0.0.1', () => {
          const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
          for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
          upstream.write(lines.join('\r\n') + '\r\n\r\n')
          if (head.length) upstream.write(head)
          socket.pipe(upstream).pipe(socket)
        })
        const end = () => {
          upstream.destroy()
          socket.destroy()
        }
        upstream.on('error', end)
        socket.on('error', end)
        upstream.on('close', end)
        socket.on('close', end)
      })
    }
  }
}
