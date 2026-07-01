import { describe, expect, mock, test } from 'bun:test'
import { SESSION_LIMITS } from '@browseros/shared/constants/limits'
import { type AgentSession, SessionStore } from '../../src/agent/session-store'

// Eviction is fire-and-forget inside set(); let its microtasks/macrotasks
// settle before asserting.
const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const makeSession = () => {
  const dispose = mock(async () => {})
  const session = { agent: { dispose } } as unknown as AgentSession
  return { session, dispose }
}

describe('SessionStore eviction', () => {
  test('LRU-evicts oldest sessions beyond MAX_COUNT and disposes them', async () => {
    const store = new SessionStore()
    const total = SESSION_LIMITS.MAX_COUNT + 5
    const disposes = new Map<string, ReturnType<typeof mock>>()

    for (let i = 0; i < total; i++) {
      const { session, dispose } = makeSession()
      disposes.set(`c${i}`, dispose)
      store.set(`c${i}`, session)
    }
    await flush()

    expect(store.count()).toBe(SESSION_LIMITS.MAX_COUNT)

    // The first 5 (least-recently-used) are gone and disposed.
    for (let i = 0; i < 5; i++) {
      expect(store.has(`c${i}`)).toBe(false)
      expect(disposes.get(`c${i}`)?.mock.calls.length).toBe(1)
    }
    // The most recent MAX_COUNT survive.
    expect(store.has(`c${total - 1}`)).toBe(true)
  })

  test('get() refreshes recency so an accessed session is not the LRU victim', async () => {
    const store = new SessionStore()
    const max = SESSION_LIMITS.MAX_COUNT

    for (let i = 0; i < max; i++) {
      store.set(`c${i}`, makeSession().session)
    }
    await flush()
    expect(store.count()).toBe(max)

    // Touch the oldest so it becomes most-recently-used.
    store.get('c0')

    // One more insert forces a single eviction.
    store.set('extra', makeSession().session)
    await flush()

    expect(store.count()).toBe(max)
    expect(store.has('c0')).toBe(true) // protected by the get()
    expect(store.has('c1')).toBe(false) // now the LRU victim
  })

  test('delete() disposes and drops the session', async () => {
    const store = new SessionStore()
    const { session, dispose } = makeSession()
    store.set('c0', session)

    const deleted = await store.delete('c0')

    expect(deleted).toBe(true)
    expect(store.has('c0')).toBe(false)
    expect(dispose.mock.calls.length).toBe(1)
  })
})
