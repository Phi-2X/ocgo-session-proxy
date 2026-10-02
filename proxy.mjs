#!/usr/bin/env node
/**
 * A local reverse proxy that lets any OpenAI- or Anthropic-compatible client
 * talk to OpenCode Go.
 *
 * OpenCode Go requires a stable `x-opencode-session` header per conversation.
 * Most agent frameworks have no such concept, so their requests are rejected
 * with `MissingSessionID`. This proxy listens on `http://127.0.0.1:<port>`,
 * derives a conversation identity from each request body (see ./session.mjs),
 * stamps the header, and forwards the request to the gateway.
 *
 * Design rules:
 *   - transparent: paths, query strings, bodies, status codes and response
 *     bytes pass through untouched, including streaming SSE as it arrives;
 *   - credential-free: the client's own API key (Authorization bearer or
 *     x-api-key) is forwarded as-is, so the proxy stays a dumb pipe;
 *   - never a single shared session id: a request that cannot be attributed to
 *     a conversation gets a private, throwaway id;
 *   - bound to 127.0.0.1 by default, so it is not exposed to the network.
 *
 * @module ocgo-proxy
 */

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { SessionStore, extractConversation } from './session.mjs'

/** Header OpenCode Go documents and requires. */
export const SESSION_HEADER = 'x-opencode-session'
/** Session affinity spelling the same gateway also accepts; sent for routing stability. */
export const EXTRA_SESSION_HEADER = 'x-session-id'
/** Headers that belong to a single hop and must never be forwarded. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect',
])
/** User agents that identify a transport library rather than a client application. */
const GENERIC_AGENT = /(undici|node-fetch|node\.js|axios|got\b|superagent|python-requests|python-httpx|httpx|aiohttp|okhttp|go-http-client|curl|wget|postmanruntime|apifox|java\/|guzzle|libcurl|openai-python|openai-node|anthropic-sdk|dart\/)/i

/** @typedef {ReturnType<typeof resolveConfig>} Config */

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  upstream: 'https://opencode.ai/zen/go',
  trustClientSession: false,
  extraSessionHeader: true,
  sessionTtlHours: 24,
  maxSessions: 2000,
  state: '',
  maxBodyMb: 64,
  hardMaxBodyMb: 512,
  connectTimeoutMs: 20000,
  logFile: '',
  quiet: false,
  cors: true,
  agent: 'ocgo-local-proxy/1.0',
}

const HELP = `
ocgo-session-proxy — stamp OpenCode Go requests with a per-conversation session id

Usage:
  node proxy.mjs [options]

Point any OpenAI-compatible client at:      http://127.0.0.1:<port>/v1
Point any Anthropic-compatible client at:   http://127.0.0.1:<port>
Point an OpenAI Responses client at:        http://127.0.0.1:<port>/v1
The client supplies its own OpenCode Go API key; the proxy stores none.

Options:
  --port <n>                 listen port                     (env OCGO_PORT, default 8787)
  --host <addr>              listen address                  (env OCGO_HOST, default 127.0.0.1)
  --upstream <url>           gateway base URL                (env OCGO_UPSTREAM)
  --trust-client-session     keep a session header the client sent instead of deriving one
  --no-extra-session-header  do not send ${EXTRA_SESSION_HEADER}
  --session-ttl-hours <n>    idle time before a conversation is forgotten (default 24)
  --max-sessions <n>         remembered conversations          (default 2000)
  --state <file>             persist session ids across restarts (digests only)
  --max-body-mb <n>          above this size a body is not parsed (default 64)
  --hard-max-body-mb <n>     above this size a request is rejected with 413 (default 512)
  --connect-timeout-ms <n>   upstream connect timeout          (default 20000)
  --log <file>               also append request lines to a file
  --cors / --no-cors         CORS handling, on by default
  --agent <name>             User-Agent sent upstream when the client's is a bare library
  --quiet                    no per-request log lines
  --help                     this text

Diagnostics (never forwarded upstream):
  GET /_proxy/health   GET /_proxy/stats   GET /_proxy/sessions   GET /_proxy/help
`.trim()

/** @param {string|undefined} value @returns {boolean|undefined} */
function parseBool(value) {
  if (value === undefined) return undefined
  const lowered = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false
  return undefined
}

/** @param {number} value @param {string} name */
function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

/**
 * Merge defaults, environment and command-line flags. The command line wins.
 * @param {string[]} [argv]
 * @param {Record<string, unknown>} [overrides]
 * @returns {Config}
 */
export function resolveConfig(argv = [], overrides = {}) {
  const env = process.env
  /** @type {Record<string, unknown>} */
  const config = {
    ...DEFAULTS,
    port: Number(env.OCGO_PORT ?? DEFAULTS.port),
    host: env.OCGO_HOST ?? DEFAULTS.host,
    upstream: env.OCGO_UPSTREAM ?? DEFAULTS.upstream,
    state: env.OCGO_STATE ?? DEFAULTS.state,
    logFile: env.OCGO_LOG ?? DEFAULTS.logFile,
    agent: env.OCGO_AGENT ?? DEFAULTS.agent,
    trustClientSession: parseBool(env.OCGO_TRUST_CLIENT_SESSION) ?? DEFAULTS.trustClientSession,
    cors: parseBool(env.OCGO_CORS) ?? DEFAULTS.cors,
    help: false,
  }

  /** @type {Record<string, (value: string) => void>} */
  const valueFlags = {
    '--port': (value) => { config.port = nonNegative(Number(value), '--port') },
    '--host': (value) => { config.host = value },
    '--upstream': (value) => { config.upstream = value },
    '--session-ttl-hours': (value) => { config.sessionTtlHours = nonNegative(Number(value), '--session-ttl-hours') },
    '--max-sessions': (value) => { config.maxSessions = nonNegative(Number(value), '--max-sessions') },
    '--state': (value) => { config.state = value },
    '--max-body-mb': (value) => { config.maxBodyMb = nonNegative(Number(value), '--max-body-mb') },
    '--hard-max-body-mb': (value) => { config.hardMaxBodyMb = nonNegative(Number(value), '--hard-max-body-mb') },
    '--connect-timeout-ms': (value) => { config.connectTimeoutMs = nonNegative(Number(value), '--connect-timeout-ms') },
    '--log': (value) => { config.logFile = value },
    '--agent': (value) => { config.agent = value },
  }
  /** @type {Record<string, () => void>} */
  const boolFlags = {
    '--trust-client-session': () => { config.trustClientSession = true },
    '--no-trust-client-session': () => { config.trustClientSession = false },
    '--extra-session-header': () => { config.extraSessionHeader = true },
    '--no-extra-session-header': () => { config.extraSessionHeader = false },
    '--cors': () => { config.cors = true },
    '--no-cors': () => { config.cors = false },
    '--quiet': () => { config.quiet = true },
    '--help': () => { config.help = true },
    '-h': () => { config.help = true },
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const equals = token.indexOf('=')
    const name = equals === -1 ? token : token.slice(0, equals)
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    if (boolFlags[name] !== undefined) {
      boolFlags[name]()
      continue
    }
    if (valueFlags[name] !== undefined) {
      const value = inline ?? argv[index + 1]
      if (value === undefined) throw new Error(`${name} needs a value`)
      if (inline === undefined) index += 1
      valueFlags[name](value)
      continue
    }
    if (token.startsWith('-')) throw new Error(`unknown option: ${token} (try --help)`)
  }

  Object.assign(config, overrides)
  config.maxBodyMb = nonNegative(Number(config.maxBodyMb), 'maxBodyMb')
  config.hardMaxBodyMb = Math.max(config.maxBodyMb, nonNegative(Number(config.hardMaxBodyMb), 'hardMaxBodyMb'))
  config.upstream = String(config.upstream).replace(/\/+$/, '')
  try {
    const parsed = new URL(config.upstream)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
  } catch {
    throw new Error(`--upstream must be an http(s) URL, got: ${config.upstream}`)
  }
  return /** @type {Config} */ (config)
}

/**
 * Map a client path onto the gateway's path space.
 * @param {string} rawPath
 */
export function normalizePath(rawPath) {
  let normalized = rawPath === '' ? '/' : rawPath
  // Clients that append `/v1` on top of a base URL that already ended in `/v1`.
  normalized = normalized.replace(/\/v1(?:\/v1)+\//g, '/v1/')
  // Clients that post to /chat/completions because their base URL omitted /v1.
  if (/^\/(chat\/completions|completions|messages|responses|models|embeddings|moderations)(\/|$)/.test(normalized)) {
    normalized = `/v1${normalized}`
  }
  return normalized
}

/** @param {string} base @param {string} suffix */
function joinPaths(base, suffix) {
  const left = base.endsWith('/') ? base.slice(0, -1) : base
  const right = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${left}${right}` || '/'
}

/** @param {NodeJS.Dict<string|string[]>} headers @param {string} name */
function headerValue(headers, name) {
  const raw = headers[name]
  if (raw === undefined) return undefined
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * Pick the User-Agent to forward: keep a real client, replace a bare library.
 * Go asks clients to identify themselves rather than sending a library name.
 * @param {string|undefined} original @param {string} configured
 */
export function chooseUserAgent(original, configured) {
  if (typeof original !== 'string' || original.trim().length === 0) return configured
  if (GENERIC_AGENT.test(original)) return configured
  return original
}

/** Read a request body, refusing to buffer past `limit`. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ buffer: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge, size }))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('client aborted the request')))
  })
}

/**
 * Decide which session id belongs to this request.
 * @param {Config} config @param {SessionStore} store
 * @param {NodeJS.Dict<string|string[]>} headers @param {Buffer} bodyBuffer
 * @returns {{id: string, source: string}}
 */
export function resolveSession(config, store, headers, bodyBuffer) {
  if (config.trustClientSession) {
    const provided = headerValue(headers, SESSION_HEADER) ?? headerValue(headers, EXTRA_SESSION_HEADER)
    if (typeof provided === 'string' && provided.trim().length > 0) return { id: provided.trim(), source: 'client' }
  }
  if (bodyBuffer.length === 0) return { id: store.staticId, source: 'static' }
  if (bodyBuffer.length > config.maxBodyMb * 1024 * 1024) return { id: store.ephemeralId(), source: 'oversized' }
  let parsed
  try {
    parsed = JSON.parse(bodyBuffer.toString('utf8'))
  } catch {
    return { id: store.ephemeralId(), source: 'unparsed' }
  }
  const conversation = extractConversation(parsed)
  if (conversation === null) return { id: store.ephemeralId(), source: 'unknown' }
  const resolved = store.resolve(conversation)
  return { id: resolved.id, source: resolved.source }
}

/**
 * Build the header set sent upstream.
 * @param {Config} config
 * @param {import('node:http').IncomingMessage} req
 * @param {Buffer} bodyBuffer
 * @param {string} sessionId
 * @returns {Record<string, string|string[]>}
 */
export function buildUpstreamHeaders(config, req, bodyBuffer, sessionId) {
  /** @type {Record<string, string|string[]>} */
  const headers = {}
  const connectionTokens = new Set(
    String(req.headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  )
  for (const [name, value] of Object.entries(req.headers)) {
    const lowered = name.toLowerCase()
    if (HOP_BY_HOP.has(lowered) || connectionTokens.has(lowered)) continue
    // The client's Host is meaningless upstream, and this proxy owns the session headers.
    if (lowered === 'host' || lowered === SESSION_HEADER || lowered === EXTRA_SESSION_HEADER) continue
    headers[lowered] = Array.isArray(value) ? value.join(', ') : value
  }
  headers[SESSION_HEADER] = sessionId
  if (config.extraSessionHeader) headers[EXTRA_SESSION_HEADER] = sessionId
  headers.host = new URL(config.upstream).host
  const agent = chooseUserAgent(headerValue(req.headers, 'user-agent'), config.agent)
  if (typeof agent === 'string' && agent.length > 0) headers['user-agent'] = agent
  if (bodyBuffer.length > 0) headers['content-length'] = String(bodyBuffer.length)
  else if (['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) headers['content-length'] = '0'
  else delete headers['content-length']
  return headers
}

/** Strip hop-by-hop headers from an upstream response, keeping wire-level ones intact. */
export function filterResponseHeaders(rawHeaders) {
  /** @type {Record<string, string|string[]>} */
  const headers = {}
  const connectionTokens = new Set(
    String(rawHeaders.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  )
  for (const [name, value] of Object.entries(rawHeaders)) {
    const lowered = name.toLowerCase()
    if (HOP_BY_HOP.has(lowered) || connectionTokens.has(lowered)) continue
    headers[lowered] = value
  }
  return headers
}

/** JSON error in the shape OpenAI-compatible clients expect to parse. */
function sendError(res, status, message, type = 'proxy_error') {
  if (res.headersSent) {
    res.end()
    return
  }
  const payload = JSON.stringify({ error: { message, type, code: status } })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** @param {string} target */
function transportFor(target) {
  return target.startsWith('https:') ? https : http
}

/**
 * Start the proxy.
 * @param {Record<string, unknown>} [options] - config overrides.
 * @returns {Promise<{server: import('node:http').Server, store: SessionStore, config: Config, url: string, port: number, stats: Record<string, unknown>, close: () => Promise<void>}>}
 */
export async function startProxy(options = {}) {
  // Callers pass a fully resolved config (the CLI path parses argv once in main),
  // so no command-line token is interpreted twice here.
  const config = resolveConfig([], options)
  const store = new SessionStore({
    ttlMs: config.sessionTtlHours * 60 * 60 * 1000,
    maxSessions: config.maxSessions,
  })

  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 })
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 })
  const stats = {
    startedAt: Date.now(),
    requests: 0,
    forwarded: 0,
    rejected: 0,
    upstreamErrors: 0,
    bytesIn: 0,
    bytesOut: 0,
    bySource: {},
    byStatus: {},
    recent: [],
  }

  if (config.state) {
    try {
      const loaded = store.load(JSON.parse(fs.readFileSync(config.state, 'utf8')))
      if (!config.quiet && loaded > 0) console.log(`state: restored ${loaded} conversation(s) from ${config.state}`)
    } catch (error) {
      if (error?.code !== 'ENOENT' && !config.quiet) console.warn(`state: could not read ${config.state}: ${error.message}`)
    }
  }

  let stateTimer
  const saveState = () => {
    if (!config.state) return
    try {
      const temporary = `${config.state}.tmp`
      fs.mkdirSync(path.dirname(path.resolve(config.state)), { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify(store.toJSON()))
      fs.renameSync(temporary, config.state)
    } catch (error) {
      if (!config.quiet) console.warn(`state: could not save ${config.state}: ${error.message}`)
    }
  }
  const scheduleStateSave = () => {
    if (!config.state || stateTimer !== undefined) return
    stateTimer = setTimeout(() => {
      stateTimer = undefined
      saveState()
    }, 5000)
    stateTimer.unref?.()
  }

  const logRequest = (line) => {
    stats.recent.push(line)
    if (stats.recent.length > 50) stats.recent.shift()
    if (!config.quiet) console.log(line)
    if (config.logFile) fs.appendFile(config.logFile, `${line}\n`, () => {})
  }

  /** Diagnostics. These routes never reach the gateway. */
  const handleAdmin = (req, res, url) => {
    const route = url.pathname.replace(/\/+$/, '') || '/_proxy'
    if (route === '/_proxy/help' || route === '/_proxy') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(HELP) })
      res.end(HELP)
      return true
    }
    let payload
    if (route === '/_proxy/health') {
      payload = {
        ok: true,
        uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
        upstream: config.upstream,
        sessions: store.entries.size,
      }
    } else if (route === '/_proxy/stats') {
      payload = {
        uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
        requests: stats.requests,
        forwarded: stats.forwarded,
        rejected: stats.rejected,
        upstreamErrors: stats.upstreamErrors,
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        bySource: stats.bySource,
        byStatus: stats.byStatus,
        recent: stats.recent.slice(-20),
        sessions: store.stats(),
      }
    } else if (route === '/_proxy/sessions') {
      payload = { sessions: store.list(100) }
    } else {
      return false
    }
    const body = JSON.stringify(payload, null, 2)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return true
  }

  /** @type {import('node:http').RequestListener} */
  const handler = (req, res) => {
    const startedAt = Date.now()
    stats.requests += 1

    if (config.cors) {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-expose-headers', '*')
    }

    let url
    try {
      url = new URL(req.url ?? '/', `http://${config.host}`)
    } catch {
      sendError(res, 400, 'malformed request target')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': headerValue(req.headers, 'access-control-request-headers') ?? '*',
        'access-control-max-age': '86400',
      })
      res.end()
      return
    }

    if (url.pathname === '/_proxy' || url.pathname.startsWith('/_proxy/')) {
      if (!handleAdmin(req, res, url)) sendError(res, 404, `unknown proxy route: ${url.pathname}`)
      return
    }

    readBody(req, config.hardMaxBodyMb * 1024 * 1024)
      .then(({ buffer, tooLarge }) => {
        if (tooLarge) {
          stats.rejected += 1
          logRequest(`${new Date().toISOString()} ${req.method} ${url.pathname} -> 413 body larger than ${config.hardMaxBodyMb}MB`)
          sendError(res, 413, `request body exceeds ${config.hardMaxBodyMb}MB`, 'request_too_large')
          return
        }
        forward(req, res, url, buffer, startedAt)
      })
      .catch((error) => {
        stats.rejected += 1
        sendError(res, 400, `could not read request body: ${error.message}`)
      })
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url @param {Buffer} bodyBuffer @param {number} startedAt
   */
  function forward(req, res, url, bodyBuffer, startedAt) {
    let session
    try {
      session = resolveSession(config, store, req.headers, bodyBuffer)
    } catch (error) {
      session = { id: store.ephemeralId(), source: 'error' }
      logRequest(`${new Date().toISOString()} session derivation failed: ${error.message}`)
    }
    stats.bySource[session.source] = (stats.bySource[session.source] ?? 0) + 1
    if (config.state) scheduleStateSave()

    const base = new URL(config.upstream)
    const target = new URL(config.upstream)
    target.pathname = joinPaths(base.pathname, normalizePath(url.pathname))
    target.search = url.search
    const upstreamHost = target.host

    let headers
    try {
      headers = buildUpstreamHeaders(config, req, bodyBuffer, session.id)
    } catch (error) {
      stats.rejected += 1
      sendError(res, 400, `could not build upstream headers: ${error.message}`)
      return
    }

    let model
    if (!config.quiet && bodyBuffer.length > 0 && bodyBuffer.length <= config.maxBodyMb * 1024 * 1024) {
      try {
        const parsed = JSON.parse(bodyBuffer.toString('utf8'))
        if (typeof parsed?.model === 'string') model = parsed.model
      } catch {
        /* the log line simply omits the model */
      }
    }

    let settled = false
    let connectTimer
    let status = 502
    let firstByteAt
    let bytes = 0
    const settle = () => {
      if (settled) return
      settled = true
      if (connectTimer !== undefined) clearTimeout(connectTimer)
      stats.bytesOut += bytes
      stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1
      const parts = [
        new Date(startedAt).toISOString(),
        `${req.method ?? 'GET'} ${url.pathname}`,
        model === undefined ? undefined : `model=${model}`,
        `session=${session.id}(${session.source})`,
        `-> ${status}`,
        `${Date.now() - startedAt}ms`,
        firstByteAt === undefined ? undefined : `ttfb=${firstByteAt - startedAt}ms`,
        `${bytes}B`,
      ].filter((part) => part !== undefined)
      logRequest(parts.join(' '))
    }

    const upstreamReq = transportFor(target.href).request(
      target,
      { method: req.method, headers, agent: target.protocol === 'https:' ? httpsAgent : httpAgent },
      (upstreamRes) => {
        if (connectTimer !== undefined) clearTimeout(connectTimer)
        status = upstreamRes.statusCode ?? 502
        stats.forwarded += 1
        try {
          res.writeHead(status, filterResponseHeaders(upstreamRes.headers))
          res.flushHeaders?.()
        } catch (error) {
          upstreamRes.destroy()
          sendError(res, 502, `could not write response: ${error.message}`)
          settle()
          return
        }
        upstreamRes.on('data', (chunk) => {
          if (firstByteAt === undefined) firstByteAt = Date.now()
          bytes += chunk.length
          stats.bytesIn += chunk.length
        })
        upstreamRes.on('error', (error) => {
          stats.upstreamErrors += 1
          logRequest(`${new Date().toISOString()} ${req.method} ${url.pathname} response stream failed: ${error.message}`)
          if (!res.writableEnded) res.destroy()
        })
        upstreamRes.pipe(res)
      },
    )

    connectTimer = setTimeout(() => {
      if (settled) return
      stats.upstreamErrors += 1
      logRequest(`${new Date().toISOString()} ${req.method} ${url.pathname} could not reach ${upstreamHost} within ${config.connectTimeoutMs}ms`)
      upstreamReq.destroy(new Error(`could not reach ${upstreamHost} within ${config.connectTimeoutMs}ms`))
    }, config.connectTimeoutMs)

    upstreamReq.on('socket', (socket) => {
      socket.setNoDelay?.(true)
      if (socket.connecting) socket.once('connect', () => clearTimeout(connectTimer))
      else clearTimeout(connectTimer)
    })
    upstreamReq.on('error', (error) => {
      stats.upstreamErrors += 1
      if (!settled) {
        status = 502
        sendError(res, 502, `upstream request failed: ${error.message}`, 'upstream_error')
        settle()
      }
    })
    res.on('close', () => {
      if (!res.writableFinished) {
        if (connectTimer !== undefined) clearTimeout(connectTimer)
        upstreamReq.destroy()
      }
      settle()
    })
    upstreamReq.end(bodyBuffer)
  }

  const server = http.createServer(handler)
  server.keepAliveTimeout = 65000
  server.headersTimeout = 66000

  server.on('clientError', (error, socket) => {
    void error
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  server.on('error', (error) => {
    console.error(`proxy: server error: ${error.message}`)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  const url = `http://${config.host}:${port}`

  const close = async () => {
    if (stateTimer !== undefined) clearTimeout(stateTimer)
    saveState()
    httpAgent.destroy()
    httpsAgent.destroy()
    server.closeIdleConnections?.()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }

  return { server, store, config, url, port, stats, close }
}

/** Run the proxy in the foreground until interrupted. */
async function main() {
  let config
  try {
    config = resolveConfig(process.argv.slice(2))
  } catch (error) {
    console.error(`proxy: ${error.message}`)
    process.exitCode = 2
    return
  }
  if (config.help) {
    console.log(HELP)
    return
  }

  const { url, close, store } = await startProxy(config)
  if (!config.quiet) {
    console.log(`ocgo-session-proxy listening on ${url}`)
    console.log(`  upstream         ${config.upstream}`)
    console.log(`  OpenAI base URL  ${url}/v1   |   Anthropic base URL  ${url}`)
    console.log(`  session headers  ${SESSION_HEADER}${config.extraSessionHeader ? `, ${EXTRA_SESSION_HEADER}` : ''} (derived per request)`)
    console.log(`  diagnostics      ${url}/_proxy/health, /_proxy/stats, /_proxy/sessions`)
    console.log(`  ${store.entries.size} conversation(s) in memory; the client supplies its own API key`)
  }

  const shutdown = async (signal) => {
    if (!config.quiet) console.log(`\nproxy: ${signal} received, shutting down`)
    await close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`proxy: fatal: ${error?.stack ?? error}`)
    process.exitCode = 1
  })
}
