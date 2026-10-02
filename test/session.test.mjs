/**
 * Unit tests for conversation identity: what makes two requests the same
 * conversation, and what keeps unrelated conversations apart.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionStore, bestAlignment, extractConversation, render } from '../session.mjs'

const user = (content) => ({ role: 'user', content })
const assistant = (content) => ({ role: 'assistant', content })
const system = (content) => ({ role: 'system', content })
const chat = (messages, extra = {}) => ({ model: 'kimi-k2.6', stream: true, messages, ...extra })

/** Resolve one request body through a fresh store and return its id. */
const idFor = (store, body) => store.resolve(extractConversation(body)).id

test('appending turns keeps one conversation id', () => {
  const store = new SessionStore()
  const turns = [
    chat([user('list the files')]),
    chat([user('list the files'), assistant('src, test'), user('open src')]),
    chat([user('list the files'), assistant('src, test'), user('open src'), assistant('opened'), user('now what')]),
  ]
  const ids = turns.map((body) => idFor(store, body))
  assert.equal(new Set(ids).size, 1, `expected one id, got ${ids.join(', ')}`)
  assert.equal(store.entries.size, 1)
})

test('a different opening is a different conversation', () => {
  const store = new SessionStore()
  const first = idFor(store, chat([user('list the files')]))
  const second = idFor(store, chat([user('delete the logs')]))
  assert.notEqual(first, second)
  assert.equal(store.entries.size, 2)
})

test('a system prompt that changes every turn does not break the conversation', () => {
  const store = new SessionStore()
  const turn = (date, messages) => chat([system(`Today is ${date}. Be brief.`), ...messages])
  const first = idFor(store, turn('2026-09-10', [user('task')]))
  const second = idFor(store, turn('2026-09-11', [user('task'), assistant('ok'), user('next')]))
  const third = idFor(store, turn('2026-09-12', [user('task'), assistant('ok'), user('next'), assistant('done'), user('again')]))
  assert.equal(new Set([first, second, third]).size, 1)
})

test('a client that trims its history window keeps the conversation', () => {
  const store = new SessionStore()
  const history = Array.from({ length: 30 }, (_, index) =>
    index % 2 === 0 ? user(`question ${index}`) : assistant(`answer ${index}`))
  assert.equal(store.resolve(extractConversation(chat(history))).source, 'new')
  // The client now sends only the tail of the same conversation.
  const window = history.slice(20).concat(user('follow up'))
  const resolved = store.resolve(extractConversation(chat(window)))
  assert.equal(resolved.source, 'matched')
  assert.equal(resolved.id, [...store.entries.keys()][0])
})

test('conversations that diverge after a shared opening stay separate', () => {
  const store = new SessionStore()
  const shared = user('hello')
  idFor(store, chat([shared, assistant('hi there')]))
  const before = store.entries.size
  const resolved = store.resolve(extractConversation(chat([{ ...shared }, assistant('completely different answer')])))
  assert.equal(resolved.source, 'new')
  assert.equal(store.entries.size, before + 1)
})

test('Anthropic messages with a top-level system prompt', () => {
  const store = new SessionStore()
  const first = idFor(store, { model: 'minimax-m3', system: 'You are terse.', messages: [user('hi')] })
  const second = idFor(store, { model: 'minimax-m3', system: 'You are terse.', messages: [user('hi'), assistant('yo'), user('more')] })
  assert.equal(first, second)
})

test('OpenAI Responses API input arrays', () => {
  const store = new SessionStore()
  const first = idFor(store, { model: 'gpt-5.6-luna', instructions: 'be terse', input: [user('hi')] })
  const second = idFor(store, { model: 'gpt-5.6-luna', instructions: 'be terse', input: [user('hi'), assistant('yo'), user('more')] })
  assert.equal(first, second)
})

test('Gemini contents', () => {
  const store = new SessionStore()
  const first = idFor(store, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
  const second = idFor(store, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [{ text: 'yo' }] }, { role: 'user', parts: [{ text: 'more' }] }] })
  assert.equal(first, second)
})

test('an unknown body shape still gets a stable per-conversation id', () => {
  const store = new SessionStore()
  const first = idFor(store, { framework: 'astrbot', round: [{ question: 'alpha' }] })
  const second = idFor(store, { framework: 'astrbot', round: [{ question: 'alpha' }, { question: 'beta' }] })
  assert.equal(first, second)
})

test('noise keys do not change a message identity', () => {
  assert.equal(
    render({ role: 'user', content: 'hi', id: 'request-1', cache_control: { type: 'ephemeral' } }),
    render({ role: 'user', content: 'hi', id: 'request-2' }),
  )
  assert.notEqual(render({ role: 'user', content: 'hi' }), render({ role: 'assistant', content: 'hi' }))
})

test('a body with no conversation content yields throwaway ids', () => {
  const store = new SessionStore()
  const first = store.resolve(extractConversation({ messages: [] }))
  const second = store.resolve(extractConversation({ messages: [] }))
  assert.equal(first.source, 'ephemeral')
  assert.equal(second.source, 'ephemeral')
  assert.notEqual(first.id, second.id)
  assert.equal(store.entries.size, 0)
})

test('idle conversations expire', () => {
  let clock = 1_000
  const store = new SessionStore({ ttlMs: 5_000, now: () => clock })
  const body = chat([user('one'), assistant('two')])
  const first = idFor(store, body)
  clock += 4_000
  assert.equal(idFor(store, body), first)
  clock += 60_000
  const afterExpiry = idFor(store, body)
  assert.notEqual(afterExpiry, first, 'an expired conversation must not be reused')
})

test('capacity eviction drops the least recently used conversation', () => {
  let clock = 1_000
  const store = new SessionStore({ maxSessions: 2, now: () => (clock += 10) })
  const one = idFor(store, chat([user('one')]))
  idFor(store, chat([user('two')]))
  idFor(store, chat([user('three')]))
  assert.equal(store.entries.size, 2)
  assert.notEqual(idFor(store, chat([user('one')])), one)
})

test('session ids survive a state round trip', () => {
  const store = new SessionStore()
  const body = chat([user('persist me'), assistant('ok')])
  const id = idFor(store, body)
  const restored = new SessionStore()
  assert.equal(restored.load(JSON.parse(JSON.stringify(store.toJSON()))), 1)
  const continuation = chat([user('persist me'), assistant('ok'), user('and again')])
  assert.equal(idFor(restored, continuation), id)
})

test('load ignores payloads it cannot trust', () => {
  const store = new SessionStore()
  assert.equal(store.load(null), 0)
  assert.equal(store.load({ entries: 'nope' }), 0)
  assert.equal(store.load({ entries: [{ id: 'x', units: [] }] }), 0)
  assert.equal(store.entries.size, 0)
})

test('bestAlignment reports a head match and a skipped head', () => {
  assert.deepEqual(bestAlignment(['a', 'b', 'c'], ['a', 'b', 'c', 'd']), { score: 3, storedOffset: 0, requestOffset: 0 })
  assert.deepEqual(bestAlignment(['a', 'b', 'c'], ['x', 'b', 'c', 'd']), { score: 2, storedOffset: 1, requestOffset: 1 })
  assert.equal(bestAlignment(['a'], ['z']).score, 0)
})
