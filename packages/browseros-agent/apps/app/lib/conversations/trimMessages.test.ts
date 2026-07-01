import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import {
  capCompletedToolOutputs,
  trimConversationMessages,
} from './trimMessages'

const msg = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: 'assistant', parts }) as unknown as UIMessage

const toolPart = (
  id: string,
  state: string,
  output: unknown = [{ type: 'image', data: 'x'.repeat(200_000) }],
) => ({
  type: 'tool-screenshot',
  toolCallId: id,
  toolName: 'screenshot',
  state,
  input: {},
  output,
})

const recentTextMessages = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    msg(`r${i}`, [{ type: 'text', text: 'hi' }]),
  )

describe('trimConversationMessages', () => {
  test('strips heavy tool output from old messages, keeps tool status', () => {
    const bigShot = 'x'.repeat(500_000)
    const old = msg('old', [
      {
        type: 'tool-screenshot',
        toolCallId: 't1',
        toolName: 'screenshot',
        state: 'output-available',
        input: {},
        output: [{ type: 'image', data: bigShot }],
      },
    ])

    const [outOld] = trimConversationMessages([old, ...recentTextMessages(6)])

    // Heavy base64 payload is gone.
    expect(JSON.stringify(outOld).length).toBeLessThan(1_000)
    // Tool identity/status is preserved so the UI still renders the batch.
    const part = outOld.parts[0] as {
      toolCallId: string
      toolName: string
      state: string
      output: unknown
    }
    expect(part.toolCallId).toBe('t1')
    expect(part.toolName).toBe('screenshot')
    expect(part.state).toBe('output-available')
    expect(part.output).toEqual({ stripped: true })
  })

  test('strips file/binary data from old messages', () => {
    const old = msg('old', [
      { type: 'file', mediaType: 'image/png', data: 'y'.repeat(300_000) },
    ])

    const [outOld] = trimConversationMessages([old, ...recentTextMessages(6)])

    const part = outOld.parts[0] as { mediaType: string; data?: unknown }
    expect(part.mediaType).toBe('image/png') // metadata kept
    expect(part.data).toBeUndefined() // payload dropped
  })

  test('caps oversized text parts in old messages', () => {
    const old = msg('old', [{ type: 'text', text: 'a'.repeat(100_000) }])

    const [outOld] = trimConversationMessages([old, ...recentTextMessages(6)])

    const text = (outOld.parts[0] as { text: string }).text
    expect(text.length).toBeLessThan(100_000)
    expect(text.endsWith('... [truncated]')).toBe(true)
  })

  test('does not touch messages within the recent window', () => {
    const bigShot = 'x'.repeat(500_000)
    const recentTool = msg('recent', [
      {
        type: 'tool-screenshot',
        toolCallId: 't2',
        state: 'output-available',
        input: {},
        output: [{ type: 'image', data: bigShot }],
      },
    ])

    // Only 5 messages total (< keepRecent default 6): nothing is old.
    const input = [recentTool, ...recentTextMessages(4)]
    const out = trimConversationMessages(input)

    expect(out).toBe(input) // same reference, untouched
    expect((out[0].parts[0] as { output: unknown[] }).output).toHaveLength(1)
  })

  test('returns the same reference when nothing needs trimming', () => {
    const only = recentTextMessages(10)
    expect(trimConversationMessages(only)).toBe(only)
  })

  test('composes the global tool-output cap into recent messages', () => {
    // 8 completed tool outputs spread across recent messages; default global
    // cap keeps 6, so the 2 oldest are stripped even inside the recent window.
    const messages = Array.from({ length: 8 }, (_, i) =>
      msg(`m${i}`, [toolPart(`t${i}`, 'output-available')]),
    )
    const out = trimConversationMessages(messages)
    const stripped = out.filter(
      (m) =>
        JSON.stringify((m.parts[0] as { output: unknown }).output) ===
        '{"stripped":true}',
    )
    expect(stripped.length).toBe(2)
  })

  test('respects a custom keepRecent window', () => {
    const bigShot = 'x'.repeat(500_000)
    const older = msg('older', [
      {
        type: 'tool-x',
        toolCallId: 't3',
        state: 'output-available',
        input: {},
        output: [{ data: bigShot }],
      },
    ])
    const newer = msg('newer', [{ type: 'text', text: 'keep me' }])

    // keepRecent = 1 -> only `newer` is protected, `older` is trimmed.
    const [outOlder, outNewer] = trimConversationMessages([older, newer], 1)

    expect((outOlder.parts[0] as { output: unknown }).output).toEqual({
      stripped: true,
    })
    expect((outNewer.parts[0] as { text: string }).text).toBe('keep me')
  })
})

describe('capCompletedToolOutputs', () => {
  const outputsOf = (m: UIMessage) =>
    m.parts.map((p) => JSON.stringify((p as { output: unknown }).output))

  test('caps outputs within a single long agentic message (intra-turn)', () => {
    // The crash scenario: one assistant message with 20 completed screenshots.
    const parts = Array.from({ length: 20 }, (_, i) =>
      toolPart(`t${i}`, 'output-available'),
    )
    const single = msg('turn', parts)

    const [out] = capCompletedToolOutputs([single], 6)
    const kept = outputsOf(out).filter((o) => o !== '{"stripped":true}')
    const stripped = outputsOf(out).filter((o) => o === '{"stripped":true}')

    expect(kept.length).toBe(6) // last 6 kept
    expect(stripped.length).toBe(14) // first 14 stripped
    // The kept ones are the most recent (highest indices).
    expect(
      (out.parts[19] as { output: unknown }).output as unknown[],
    ).toHaveLength(1)
  })

  test('never strips a still-streaming (non-terminal) tool part', () => {
    const parts = [
      toolPart('done1', 'output-available'),
      toolPart('done2', 'output-available'),
      toolPart('streaming', 'input-available'), // active, not terminal
    ]
    const single = msg('turn', parts)

    // keepRecent = 1: budget would strip the two completed ones, but the
    // streaming part must be preserved regardless of budget.
    const [out] = capCompletedToolOutputs([single], 1)

    // Streaming part keeps its output untouched.
    expect(
      (out.parts[2] as { output: unknown }).output as unknown[],
    ).toHaveLength(1)
    // At least one completed part was stripped.
    const stripped = outputsOf(out).filter((o) => o === '{"stripped":true}')
    expect(stripped.length).toBeGreaterThan(0)
  })

  test('returns same reference when under budget', () => {
    const parts = [
      toolPart('a', 'output-available'),
      toolPart('b', 'output-available'),
    ]
    const input = [msg('turn', parts)]
    expect(capCompletedToolOutputs(input, 6)).toBe(input)
  })

  test('is idempotent: second pass returns same reference (no render loop)', () => {
    // Regression guard for "Maximum update depth exceeded": re-running must not
    // re-strip already-stripped parts (which would create new object identities
    // forever and loop the render-time setMessages effect).
    const parts = Array.from({ length: 20 }, (_, i) =>
      toolPart(`t${i}`, 'output-available'),
    )
    const first = capCompletedToolOutputs([msg('turn', parts)], 6)
    const second = capCompletedToolOutputs(first, 6)
    expect(second).toBe(first) // stable — no further changes
  })

  test('trimConversationMessages is idempotent', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(`m${i}`, [toolPart(`t${i}`, 'output-available')]),
    )
    const once = trimConversationMessages(messages)
    const twice = trimConversationMessages(once)
    expect(twice).toBe(once)
  })
})
