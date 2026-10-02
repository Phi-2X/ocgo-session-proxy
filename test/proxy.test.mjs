/**
 * Integration tests: a real proxy process talking to a mock gateway, checking
 * the header contract, transparent forwarding and streaming behaviour.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { SESSION_HEADER, EXTRA_SESSION_HEADER, chooseUserAgent, normalizePath, resolveConfig, startProxy } from '../proxy.mjs'

const user = (content) => ({ role: 'user', content })
const assistant = (content) => ({ role: 'assistant', content })
const chat = (messages) => JSON.stringify({ model: 'kimi-k2.6', stream: false, messages })

/** A stand-in for the OpenCode Go gateway that records what it receives. */
async function mockGateway(respond) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(record)
      respond(record, req, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    seen,
    url: `http://127.0.0.1:${address.port}/zen/go`,
    host: `127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Start a proxy against a mock gateway and register cleanup. */
async function startProxyFor(t, gateway, options = {}) {
  const proxy = await startProxy({ port: 0, upstream: gateway.url, quiet: true, ...options })
  t.after(async () => {
    await proxy.close()
    await gateway.close()
  })
  return proxy
}

/** Send one request through the proxy and collect the whole response. */
function call(port, path, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

const json = (body) => ({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })

test('stamps the session header and overrides a static client header', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const proxy = await startProxyFor(t, gateway)
  const body = chat([user('hello'), assistant('hi'), user('more')])
  const response = await call(proxy.port, '/v1/chat/completions', {
    headers: { ...json(body), authorization: 'Bearer sk-test', [SESSION_HEADER]: 'static-configured-value' },
    body,
  })

  assert.equal(response.status, 200)
  assert.equal(gateway.seen.length, 1)
  const sent = gateway.seen[0].headers
  assert.ok(sent[SESSION_HEADER], 'the gateway must never see a request without the session header')
  assert.notEqual(sent[SESSION_HEADER], 'static-configured-value')
  assert.equal(sent[EXTRA_SESSION_HEADER], sent[SESSION_HEADER])
  assert.equal(sent.authorization, 'Bearer sk-test', 'the client key is forwarded untouched')
  assert.equal(sent.host, gateway.host)
})

test('one conversation keeps one id, two conversations differ', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway)

  const turns = [
    chat([user('list the files')]),
    chat([user('list the files'), assistant('src'), user('open src')]),
    chat([user('list the files'), assistant('src'), user('open src'), assistant('ok'), user('next')]),
  ]
  for (const body of turns) await call(proxy.port, '/v1/chat/completions', { headers: json(body), body })
  await call(proxy.port, '/v1/chat/completions', { headers: json(chat([user('something else')])), body: chat([user('something else')]) })

  const sessions = gateway.seen.map((record) => record.headers[SESSION_HEADER])
  assert.equal(sessions.length, 4)
  assert.equal(new Set(sessions.slice(0, 3)).size, 1, `turns of one conversation must agree: ${sessions.slice(0, 3).join(', ')}`)
  assert.notEqual(sessions[3], sessions[0])
})

test('normalizes client path spellings', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, {})
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway)
  const body = chat([user('hi')])

  await call(proxy.port, '/chat/completions', { headers: json(body), body })
  await call(proxy.port, '/v1/v1/chat/completions', { headers: json(body), body })
  await call(proxy.port, '/v1/messages', { headers: json(body), body })
  await call(proxy.port, '/v1/chat/completions?stream=true', { headers: json(body), body })

  assert.deepEqual(gateway.seen.map((record) => record.url), [
    '/zen/go/v1/chat/completions',
    '/zen/go/v1/chat/completions',
    '/zen/go/v1/messages',
    '/zen/go/v1/chat/completions?stream=true',
  ])
})

test('streams a response before the gateway has finished', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    setTimeout(() => res.end('data: done\n\n'), 200)
  })
  const proxy = await startProxyFor(t, gateway)
  const body = chat([user('stream please')])

  const started = Date.now()
  const events = []
  await new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: proxy.port, path: '/v1/chat/completions', method: 'POST', headers: json(body) },
      (response) => {
        assert.equal(response.headers['content-type'], 'text/event-stream')
        response.on('data', (chunk) => events.push({ at: Date.now() - started, text: chunk.toString() }))
        response.on('end', resolve)
      },
    )
    request.on('error', reject)
    request.end(body)
  })

  assert.ok(events.length >= 2, 'both chunks must arrive')
  assert.ok(events[0].at < 150, `the first chunk must not wait for the gateway to finish (arrived at ${events[0].at}ms)`)
  assert.match(events[0].text, /first/)
  assert.match(events.at(-1).text, /done/)
})

test('drops hop-by-hop headers and keeps the rest', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, { connection: 'keep-alive, x-hop-token', 'x-hop-token': 'must-not-arrive', 'x-upstream-note': 'kept' })
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway)
  const body = chat([user('hi')])
  const response = await call(proxy.port, '/v1/chat/completions', {
    headers: {
      ...json(body),
      connection: 'keep-alive, x-custom-hop',
      'x-custom-hop': 'must-not-arrive',
      expect: '100-continue',
      'x-kept': 'yes',
    },
    body,
  })

  const sent = gateway.seen[0].headers
  assert.equal(sent['x-custom-hop'], undefined)
  assert.equal(sent.expect, undefined)
  assert.equal(sent['x-kept'], 'yes')
  assert.equal(sent['content-length'], String(Buffer.byteLength(body)))
  assert.equal(response.headers['x-upstream-note'], 'kept')
  // 'connection' is hop-by-hop, so the proxy must not forward the gateway's
  // value; Node's own server then adds its own for the client connection.
  assert.equal(response.headers['x-hop-token'], undefined)
})

test('replaces a bare library User-Agent but keeps a real client one', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, {})
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway)
  const body = chat([user('hi')])

  await call(proxy.port, '/v1/chat/completions', { headers: { ...json(body), 'user-agent': 'axios/1.7.2' }, body })
  await call(proxy.port, '/v1/chat/completions', { headers: { ...json(body), 'user-agent': 'AstrBot/4.0' }, body })

  assert.equal(gateway.seen[0].headers['user-agent'], 'ocgo-local-proxy/1.0')
  assert.equal(gateway.seen[1].headers['user-agent'], 'AstrBot/4.0')
  assert.equal(chooseUserAgent(undefined, 'x/1'), 'x/1')
  assert.equal(chooseUserAgent('python-httpx/0.27', 'x/1'), 'x/1')
})

test('passes an upstream error through untouched', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    const error = JSON.stringify({ type: 'error', error: { type: 'invalid_api_key', message: 'nope' } })
    res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(error) })
    res.end(error)
  })
  const proxy = await startProxyFor(t, gateway)
  const body = chat([user('hi')])
  const response = await call(proxy.port, '/v1/chat/completions', { headers: json(body), body })

  assert.equal(response.status, 401)
  assert.match(response.body, /invalid_api_key/)
})

test('a body that cannot be parsed still carries a session header', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(400, {})
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway)
  const response = await call(proxy.port, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json', 'content-length': '9' },
    body: 'not-json!',
  })

  assert.equal(response.status, 400)
  assert.ok(gateway.seen[0].headers[SESSION_HEADER])
})

test('a bodyless GET still carries a session header', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [] }))
  })
  const proxy = await startProxyFor(t, gateway)
  const response = await call(proxy.port, '/v1/models', { method: 'GET' })

  assert.equal(response.status, 200)
  assert.ok(gateway.seen[0].headers[SESSION_HEADER])
  assert.equal(gateway.seen[0].headers[SESSION_HEADER], proxy.store.staticId)
})

test('oversized bodies are rejected instead of buffered', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, {})
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway, { maxBodyMb: 0.001, hardMaxBodyMb: 0.001 })
  const body = JSON.stringify({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'x'.repeat(4000) }] })
  const response = await call(proxy.port, '/v1/chat/completions', { headers: json(body), body })

  assert.equal(response.status, 413)
  assert.equal(gateway.seen.length, 0)
})

test('diagnostics stay local and answer CORS preflight', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, {})
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway)

  const health = await call(proxy.port, '/_proxy/health', { method: 'GET' })
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.body).ok, true)

  const preflight = await call(proxy.port, '/v1/chat/completions', {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-headers': 'authorization, content-type' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-headers'], 'authorization, content-type')
  assert.equal(gateway.seen.length, 0, 'neither route may reach the gateway')
})

test('--trust-client-session forwards a session id the client chose', async (t) => {
  const gateway = await mockGateway((record, req, res) => {
    res.writeHead(200, {})
    res.end('{}')
  })
  const proxy = await startProxyFor(t, gateway, { trustClientSession: true })
  const body = chat([user('hi')])
  await call(proxy.port, '/v1/chat/completions', { headers: { ...json(body), [SESSION_HEADER]: 'claude-code-session-42' }, body })

  assert.equal(gateway.seen[0].headers[SESSION_HEADER], 'claude-code-session-42')
})

test('config and path helpers behave', () => {
  assert.equal(normalizePath('/v1/chat/completions'), '/v1/chat/completions')
  assert.equal(normalizePath('/messages'), '/v1/messages')
  assert.equal(normalizePath('/v1/v1/models'), '/v1/models')
  assert.equal(normalizePath('/'), '/')
  assert.throws(() => resolveConfig(['--upstream', 'ftp://x']), /http\(s\) URL/)
  assert.throws(() => resolveConfig(['--nope']), /unknown option/)
  assert.equal(resolveConfig(['--port', '9000']).port, 9000)
  assert.equal(resolveConfig(['--port=9001']).port, 9001)
  assert.equal(resolveConfig(['--max-body-mb', '8', '--hard-max-body-mb', '4']).hardMaxBodyMb, 8)
})
