#!/usr/bin/env node
/**
 * Live check: prove the gateway accepts the proxied traffic and that two turns
 * of one conversation reuse the same derived session id.
 *
 * It sends a direct request first (no proxy, no session header) so you can see
 * the `MissingSessionID` error this proxy exists to remove, then the same kind
 * of traffic through the proxy. Nothing is stored; the key is only sent to the
 * gateway you already use.
 *
 *   node verify-live.mjs --key <OPENCODE_GO_KEY> [--model kimi-k2.6]
 *                        [--base http://127.0.0.1:8787] [--no-direct]
 *
 * The key can also come from OPENCODE_API_KEY.
 */

import process from 'node:process'

const USAGE = `usage: node verify-live.mjs --key <OPENCODE_GO_KEY> [options]

  --key <key>      OpenCode Go API key (or set OPENCODE_API_KEY)
  --model <id>     model id to call            (default kimi-k2.6)
  --base <url>     proxy base URL              (default http://127.0.0.1:8787)
  --no-direct      skip the direct, proxy-less probe
`

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { base: 'http://127.0.0.1:8787', model: 'kimi-k2.6', direct: true }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--key') options.key = argv[++index]
    else if (token === '--model') options.model = argv[++index]
    else if (token === '--base') options.base = argv[++index]
    else if (token === '--no-direct') options.direct = false
    else if (token === '--help' || token === '-h') options.help = true
    else throw new Error(`unknown option: ${token}`)
  }
  return options
}

/** @param {string} base @param {string} path @param {string} key @param {object} payload */
async function post(base, path, key, payload) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

/** The session id and how it was derived, read from the proxy's own log lines. */
async function lastSession(base) {
  try {
    const response = await fetch(`${base}/_proxy/stats`)
    const stats = await response.json()
    const lines = stats.recent ?? []
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = /session=(\S+?)\(([^)]+)\)/.exec(lines[index])
      if (match !== null) return { id: match[1], source: match[2], line: lines[index] }
    }
  } catch {
    /* diagnostics are best effort */
  }
  return undefined
}

/** @param {unknown} json */
function usageSummary(json) {
  const usage = json?.usage
  if (usage === undefined) return 'no usage field'
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens
  const parts = [`prompt=${usage.prompt_tokens ?? '?'}`, `completion=${usage.completion_tokens ?? '?'}`]
  if (cached !== undefined) parts.push(`cached=${cached}`)
  return parts.join(' ')
}

/** @param {unknown} json */
function errorSummary(status, text, json) {
  if (json?.error !== undefined) {
    return `${status} ${json.error.type ?? ''} ${json.error.message ?? JSON.stringify(json.error)}`.trim()
  }
  return `${status} ${text.slice(0, 200)}`
}

const messages = (turns) => turns

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }
  options.key = options.key ?? process.env.OPENCODE_API_KEY ?? process.env.OCGO_KEY
  if (typeof options.key !== 'string' || options.key.length === 0) {
    console.error('a key is required: pass --key or set OPENCODE_API_KEY')
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  const health = await fetch(`${options.base}/_proxy/health`).then((r) => r.json()).catch(() => undefined)
  if (health === undefined) {
    console.error(`the proxy is not answering on ${options.base} — start it with: node proxy.mjs`)
    process.exitCode = 1
    return
  }
  console.log(`proxy ok: upstream=${health.upstream} sessions=${health.sessions}`)

  const payload = (turns) => ({
    model: options.model,
    max_tokens: 24,
    stream: false,
    messages: messages(turns),
  })

  if (options.direct) {
    console.log('\n[1] direct gateway call, no proxy, no session header (expected to fail)')
    try {
      const response = await post('https://opencode.ai/zen/go', '/v1/chat/completions', options.key, payload([
        { role: 'user', content: 'reply with the single word: ok' },
      ]))
      const missing = /MissingSessionID/.test(response.text)
      console.log(`    ${errorSummary(response.status, response.text, response.json)}`)
      console.log(missing
        ? '    -> MissingSessionID reproduced: this is what generic clients hit.'
        : '    -> no MissingSessionID (the gateway already accepts this client shape).')
    } catch (error) {
      console.log(`    unreachable: ${error.message}`)
    }
  }

  console.log('\n[2] through the proxy: two turns of conversation A, then conversation B')
  const turnOne = [{ role: 'user', content: 'reply with the single word: alpha' }]
  const turnTwo = [...turnOne, { role: 'assistant', content: 'alpha' }, { role: 'user', content: 'reply with the single word: beta' }]
  const otherChat = [{ role: 'user', content: 'reply with the single word: gamma' }]

  const sessions = []
  for (const [label, turns] of [['A turn 1', turnOne], ['A turn 2', turnTwo], ['B turn 1', otherChat]]) {
    let response
    try {
      response = await post(options.base, '/v1/chat/completions', options.key, payload(turns))
    } catch (error) {
      console.log(`    ${label}: request failed: ${error.message}`)
      process.exitCode = 1
      return
    }
    const session = await lastSession(options.base)
    sessions.push(session?.id)
    const detail = response.status === 200
      ? usageSummary(response.json)
      : errorSummary(response.status, response.text, response.json)
    console.log(`    ${label}: ${detail}`)
    console.log(`      session=${session?.id ?? '?'} (${session?.source ?? '?'})`)
    if (/MissingSessionID/.test(response.text)) console.log('      !! the gateway still reports a missing session id')
  }

  const verdict = []
  verdict.push(sessions[0] !== undefined && sessions[0] === sessions[1]
    ? 'PASS: the two turns of conversation A share one session id'
    : 'CHECK: conversation A did not reuse its session id')
  verdict.push(sessions[2] !== undefined && sessions[2] !== sessions[0]
    ? 'PASS: conversation B has its own session id'
    : 'CHECK: conversation B did not get a distinct session id')
  console.log(`\n${verdict.join('\n')}`)
}

main().catch((error) => {
  console.error(`verify-live: ${error?.stack ?? error}`)
  process.exitCode = 1
})
