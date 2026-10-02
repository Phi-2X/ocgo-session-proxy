/**
 * Conversation identity for the OpenCode Go gateway.
 *
 * OpenCode Go refuses model requests that carry no `x-opencode-session` header
 * and asks for "a stable session ID ... for each conversation so we can
 * optimize routing and prompt caching". Generic clients — Cherry Studio,
 * AstrBot, any OpenAI/Anthropic compatible framework — have no such concept,
 * and a single configured header value would merge every conversation into one
 * identity, which is exactly what the gateway wants to avoid.
 *
 * So the value is derived from the request itself: turn the body into an
 * ordered list of per-message digests, remember that list per conversation, and
 * reuse the conversation whose stored list lines up best with this request.
 * Appending a turn keeps the earlier messages in place, so the id survives; a
 * different opening produces a different id.
 *
 * Three deliberate choices make that survive real clients:
 *   - system/developer text never takes part in the match. Guardrail-style
 *     clients rewrite it every turn (fresh timestamp, fresh date, a fresh
 *     "session started" line), which would otherwise break every request.
 *   - the alignment search may skip leading units on the *stored* side, so a
 *     client that trims its history window still resolves to the conversation
 *     it belongs to.
 *   - a single shared leading unit is enough when the two lists extend each
 *     other, which is the ordinary first-turn-to-second-turn transition.
 *
 * The module is schema-aware for the shapes that carry conversation history
 * (OpenAI chat, Anthropic messages, OpenAI Responses, Gemini contents, legacy
 * completions) and falls back to an ordered flattening of every string in the
 * body for anything else, so an unknown framework still gets a stable,
 * conversation-scoped id instead of a shared constant.
 *
 * @module ocgo-session
 */

import { createHash, randomUUID } from 'node:crypto'

/** Shared units required when the two lists line up at their heads. */
export const MIN_PREFIX = 2
/** Shared units required when the alignment skips part of either list. */
export const MIN_PREFIX_OFFSET = 3
/** How many leading units of the *request* may be skipped when aligning. */
export const MAX_REQUEST_SKIP = 2

/**
 * Body keys that carry identifiers, timings or transport knobs rather than
 * conversation content. Skipping them keeps digests stable across turns and
 * across clients that decorate the same message differently.
 */
const NOISE_KEYS = new Set([
  // identity / timing
  'id', 'index', 'created', 'created_at', 'timestamp', 'time', 'date', 'nonce', 'uuid',
  'request_id', 'requestid', 'response_id', 'previous_response_id', 'object',
  // transport / sampling knobs
  'model', 'stream', 'stream_options', 'temperature', 'top_p', 'top_k', 'max_tokens',
  'max_output_tokens', 'max_completion_tokens', 'n', 'stop', 'seed', 'logprobs',
  'top_logprobs', 'logit_bias', 'frequency_penalty', 'presence_penalty', 'response_format',
  'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'service_tier', 'truncation',
  'include', 'store', 'metadata', 'meta', 'user', 'safety_settings', 'safetysettings',
  'generation_config', 'generationconfig', 'encoding_format', 'dimensions', 'modalities',
  // provider cache markers, moved between messages by several clients
  'cache_control',
])

/** Safety rails for the generic flattener: a runaway body must not stall a request. */
const MAX_FLATTEN_DEPTH = 64
const MAX_FLATTEN_STRINGS = 4000

/** @param {string} text @returns {string} short, collision-resistant digest */
export function digestText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Deterministically render a JSON value, skipping noise keys.
 * Object keys are sorted, so two clients that serialize the same message in a
 * different key order still produce the same digest.
 * @param {unknown} value
 * @returns {string}
 */
export function render(value) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
      return String(value)
    case 'object':
      break
    default:
      return ''
  }
  if (Array.isArray(value)) return `[${value.map((item) => render(item)).join(',')}]`
  const parts = []
  for (const key of Object.keys(value).sort()) {
    if (NOISE_KEYS.has(key.toLowerCase())) continue
    parts.push(`${JSON.stringify(key)}:${render(value[key])}`)
  }
  return `{${parts.join(',')}}`
}

/** @param {string} kind - the block's role or origin, so equal text in different roles differs. */
function unitDigest(kind, value) {
  return digestText(`${kind}\u0000${render(value)}`)
}

/** @returns {{systemDigest: string, anchorDigest: string, units: string[]}} */
function finish(systemParts, units) {
  const systemDigest = systemParts.length === 0
    ? 'none'
    : digestText(systemParts.map((part) => render(part)).join('\u0001'))
  return {
    systemDigest,
    anchorDigest: digestText(`${systemDigest}\u0000${units[0] ?? ''}`),
    units,
  }
}

/** OpenAI chat completions, Anthropic messages. */
function fromMessages(body) {
  if (!Array.isArray(body.messages)) return undefined
  const systemParts = []
  if (body.system !== undefined) systemParts.push(body.system)
  const units = []
  for (const message of body.messages) {
    const role = typeof message?.role === 'string' ? message.role.toLowerCase() : ''
    if (role === 'system' || role === 'developer') {
      systemParts.push(message)
      continue
    }
    units.push(unitDigest(role || 'message', message))
  }
  return { systemParts, units }
}

/** OpenAI Responses API. Also catches embedding-style `input`, which is harmless. */
function fromResponses(body) {
  if (body.input === undefined) return undefined
  const systemParts = body.instructions === undefined ? [] : [body.instructions]
  const units = []
  if (typeof body.input === 'string') {
    units.push(unitDigest('input', body.input))
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === 'string') {
        units.push(unitDigest('input', item))
        continue
      }
      const role = typeof item?.role === 'string' ? item.role.toLowerCase() : ''
      if (role === 'system' || role === 'developer') {
        systemParts.push(item)
        continue
      }
      units.push(unitDigest(role || 'input', item))
    }
  } else {
    units.push(unitDigest('input', body.input))
  }
  return { systemParts, units }
}

/** Google Gemini generateContent. */
function fromGemini(body) {
  if (!Array.isArray(body.contents)) return undefined
  const systemParts = []
  if (body.systemInstruction !== undefined) systemParts.push(body.systemInstruction)
  if (body.system_instruction !== undefined) systemParts.push(body.system_instruction)
  const units = body.contents.map((item) => {
    const role = typeof item?.role === 'string' ? item.role.toLowerCase() : ''
    return unitDigest(role || 'content', item)
  })
  return { systemParts, units }
}

/** Legacy completions, where the whole prompt is one opaque blob. */
function fromPrompt(body) {
  if (typeof body.prompt !== 'string' && !Array.isArray(body.prompt)) return undefined
  const prompts = Array.isArray(body.prompt) ? body.prompt : [body.prompt]
  return { systemParts: [], units: prompts.map((item) => unitDigest('prompt', item)) }
}

/** Every string in the body, in sorted-key order: the shape-agnostic fallback. */
function flattenStrings(value, out, depth) {
  if (out.length >= MAX_FLATTEN_STRINGS || depth > MAX_FLATTEN_DEPTH) return
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out, depth + 1)
    return
  }
  for (const key of Object.keys(value).sort()) {
    if (NOISE_KEYS.has(key.toLowerCase())) continue
    flattenStrings(value[key], out, depth + 1)
  }
}

const KNOWN_SHAPES = [fromMessages, fromResponses, fromGemini, fromPrompt]

/**
 * Turn a parsed request body into the identity material for one request.
 * @param {unknown} body - the parsed JSON body.
 * @returns {{systemDigest: string, anchorDigest: string, units: string[]}|null}
 *   `null` when there is nothing to identify; `units` is empty when the body
 *   parsed but carries no conversation content.
 */
export function extractConversation(body) {
  if (body === null || typeof body !== 'object') return null
  if (!Array.isArray(body)) {
    for (const shape of KNOWN_SHAPES) {
      const found = shape(body)
      if (found !== undefined) return finish(found.systemParts ?? [], found.units)
    }
  }
  const strings = []
  flattenStrings(body, strings, 0)
  return finish([], strings.map((item) => unitDigest('text', item)))
}

/**
 * Best alignment between a stored conversation and an incoming request.
 *
 * The request's head may be skipped by up to {@link MAX_REQUEST_SKIP} units
 * (clients sometimes prepend a volatile line), and the stored head by any
 * amount, because a client that trims its history window makes the stored
 * history *older* than what arrives. Only positions where the first compared
 * digests are equal are expanded, so the scan stays cheap.
 *
 * @param {string[]} stored
 * @param {string[]} incoming
 * @returns {{score: number, storedOffset: number, requestOffset: number}}
 */
export function bestAlignment(stored, incoming) {
  let score = 0
  let storedOffset = 0
  let requestOffset = 0
  const requestLimit = Math.min(MAX_REQUEST_SKIP, incoming.length)
  for (let j = 0; j <= requestLimit; j += 1) {
    const probe = incoming[j]
    if (probe === undefined) continue
    for (let i = 0; i < stored.length; i += 1) {
      if (stored[i] !== probe) continue
      let matched = 0
      while (i + matched < stored.length && j + matched < incoming.length && stored[i + matched] === incoming[j + matched]) {
        matched += 1
      }
      const better = matched > score ||
        (matched === score && matched > 0 && i + j < storedOffset + requestOffset)
      if (better) {
        score = matched
        storedOffset = i
        requestOffset = j
      }
      i += Math.max(0, matched - 1)
    }
  }
  return { score, storedOffset, requestOffset }
}

/** Whether `shorter` is a strict-or-equal prefix of `longer`. */
function isPrefix(shorter, longer) {
  if (shorter.length > longer.length) return false
  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] !== longer[index]) return false
  }
  return true
}

/**
 * Remembers conversations and hands back the id that belongs to a request.
 *
 * The store keeps no conversation text: only digests, so it can be persisted
 * without leaking prompt content. Resolution is a pure function of the request
 * body, which is what makes concurrent conversations from one client work.
 */
export class SessionStore {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] - how long an idle conversation stays resolvable.
   * @param {number} [options.maxSessions] - capacity; the longest-idle are evicted first.
   * @param {() => number} [options.now] - clock injection for tests.
   */
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxSessions = 2000, now = Date.now } = {}) {
    this.ttlMs = ttlMs
    this.maxSessions = maxSessions
    this.now = now
    /** Id for traffic with no conversation content at all (model listing, health probes). */
    this.staticId = `ocgo-static-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    /** @type {Map<string, {id: string, systemDigest: string, anchorDigest: string, units: string[], lastSeen: number, hits: number}>} */
    this.entries = new Map()
    this.counts = { new: 0, matched: 0, ephemeral: 0 }
    this.operations = 0
    this.lastAlignment = undefined
  }

  /** A fresh single-request id: used when nothing can be derived, never a shared constant. */
  ephemeralId() {
    return `ocgo-eph-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  }

  /**
   * Resolve the session id for one request.
   * @param {{systemDigest: string, anchorDigest: string, units: string[]}} request
   * @returns {{id: string, source: 'matched'|'new'|'ephemeral', score: number}}
   */
  resolve(request) {
    const units = Array.isArray(request?.units) ? request.units : []
    if (units.length === 0) {
      this.counts.ephemeral += 1
      return { id: this.ephemeralId(), source: 'ephemeral', score: 0 }
    }
    this.operations += 1
    if (this.operations % 256 === 0) this.sweep()

    const now = this.now()
    let best
    let bestAlignment_ = { score: 0, storedOffset: 0, requestOffset: 0 }
    for (const entry of this.entries.values()) {
      if (now - entry.lastSeen > this.ttlMs) {
        this.entries.delete(entry.id)
        continue
      }
      const alignment = bestAlignment(entry.units, units)
      if (alignment.score === 0) continue
      const headAligned = alignment.storedOffset === 0 && alignment.requestOffset === 0
      const extendsEitherWay = headAligned && (isPrefix(entry.units, units) || isPrefix(units, entry.units))
      const threshold = headAligned ? MIN_PREFIX : MIN_PREFIX_OFFSET
      if (alignment.score < threshold && !(alignment.score === 1 && extendsEitherWay)) continue
      if (best === undefined || isBetter(alignment, entry, bestAlignment_, best, request.anchorDigest)) {
        best = entry
        bestAlignment_ = alignment
      }
    }

    if (best !== undefined) {
      if (units.length > best.units.length) best.units = units
      if (request.anchorDigest !== undefined) best.anchorDigest = request.anchorDigest
      if (request.systemDigest !== undefined) best.systemDigest = request.systemDigest
      best.lastSeen = now
      best.hits += 1
      this.lastAlignment = bestAlignment_
      this.counts.matched += 1
      return { id: best.id, source: 'matched', score: bestAlignment_.score }
    }

    const entry = {
      id: `ocgo-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      systemDigest: request.systemDigest,
      anchorDigest: request.anchorDigest,
      units,
      lastSeen: now,
      hits: 0,
    }
    this.entries.set(entry.id, entry)
    this.lastAlignment = { score: 0, storedOffset: 0, requestOffset: 0 }
    this.counts.new += 1
    if (this.entries.size > this.maxSessions) this.#evictOldest()
    return { id: entry.id, source: 'new', score: 0 }
  }

  /** Drop idle conversations. Called periodically, never on every request. */
  sweep() {
    const now = this.now()
    for (const entry of [...this.entries.values()]) {
      if (now - entry.lastSeen > this.ttlMs) this.entries.delete(entry.id)
    }
  }

  #evictOldest() {
    const ordered = [...this.entries.values()].sort((a, b) => a.lastSeen - b.lastSeen)
    const excess = ordered.length - this.maxSessions
    for (let index = 0; index < excess; index += 1) this.entries.delete(ordered[index].id)
  }

  /** Diagnostic view: never includes prompt content. */
  list(limit = 50) {
    return [...this.entries.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map((entry) => ({
        id: entry.id,
        messages: entry.units.length,
        hits: entry.hits,
        lastSeen: new Date(entry.lastSeen).toISOString(),
      }))
  }

  stats() {
    return {
      sessions: this.entries.size,
      staticId: this.staticId,
      counts: { ...this.counts },
    }
  }

  /** Serialize digests only, so a restart can keep already-routed conversations. */
  toJSON() {
    return {
      version: 1,
      entries: [...this.entries.values()].map((entry) => ({
        id: entry.id,
        systemDigest: entry.systemDigest,
        anchorDigest: entry.anchorDigest,
        units: entry.units,
        lastSeen: entry.lastSeen,
        hits: entry.hits,
      })),
    }
  }

  /** @param {unknown} data - a payload produced by {@link toJSON}. @returns {number} entries restored */
  load(data) {
    if (data === null || typeof data !== 'object' || !Array.isArray(data.entries)) return 0
    const now = this.now()
    let loaded = 0
    for (const raw of data.entries) {
      if (typeof raw?.id !== 'string' || !Array.isArray(raw.units)) continue
      const units = raw.units.filter((unit) => typeof unit === 'string')
      if (units.length === 0) continue
      if (typeof raw.lastSeen === 'number' && now - raw.lastSeen > this.ttlMs) continue
      this.entries.set(raw.id, {
        id: raw.id,
        systemDigest: typeof raw.systemDigest === 'string' ? raw.systemDigest : 'none',
        anchorDigest: typeof raw.anchorDigest === 'string' ? raw.anchorDigest : '',
        units,
        lastSeen: typeof raw.lastSeen === 'number' ? raw.lastSeen : now,
        hits: typeof raw.hits === 'number' ? raw.hits : 0,
      })
      loaded += 1
    }
    if (this.entries.size > this.maxSessions) this.#evictOldest()
    return loaded
  }
}

/** Pick the better of two candidate matches: longest run, then closest to the heads. */
function isBetter(alignment, entry, currentAlignment, current, anchorDigest) {
  if (alignment.score !== currentAlignment.score) return alignment.score > currentAlignment.score
  const offsets = alignment.storedOffset + alignment.requestOffset
  const currentOffsets = currentAlignment.storedOffset + currentAlignment.requestOffset
  if (offsets !== currentOffsets) return offsets < currentOffsets
  const anchorMatches = entry.anchorDigest === anchorDigest
  const currentAnchorMatches = current.anchorDigest === anchorDigest
  if (anchorMatches !== currentAnchorMatches) return anchorMatches
  return entry.lastSeen > current.lastSeen
}
