import type { UIMessage } from 'ai'

/**
 * Messages within this many of the end keep full fidelity (visible/active
 * window). Older messages get their heavy, unrendered payloads stripped so a
 * long-running session cannot grow the heap without bound.
 */
const KEEP_RECENT_MESSAGES = 6

/**
 * Across the whole conversation (including the active, still-streaming
 * message), keep the heavy payload of only this many most-recent COMPLETED
 * tool outputs / file blobs. This is the primary memory bound: a single long
 * agentic turn is one assistant message that accumulates a screenshot per
 * step, so a per-message window is not enough — we must cap globally.
 */
const KEEP_RECENT_TOOL_OUTPUTS = 6

/** Text/reasoning parts longer than this are truncated in old messages. */
const MAX_TEXT_PART_CHARS = 32_768
const TRUNCATION_MARKER = '... [truncated]'

type MessagePart = UIMessage['parts'][number]

const isToolPart = (type: string) =>
  type.startsWith('tool-') || type === 'dynamic-tool'

// Terminal tool states never receive further stream deltas, so stripping their
// output mid-stream is safe (the AI SDK UI stream is delta-based and won't
// re-send a completed tool result). Non-terminal parts are left untouched.
const TERMINAL_TOOL_STATES = new Set([
  'result',
  'output-available',
  'output-error',
  'output-denied',
])

const hasContent = (value: unknown) => {
  if (value == null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

// The marker we replace stripped tool outputs with. Recognizing it keeps the
// cap idempotent: re-running must NOT re-strip an already-stripped part, or the
// output object identity changes every pass and the render-time effect loops
// forever (React "Maximum update depth exceeded").
const isStrippedMarker = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { stripped?: unknown }).stripped === true

const isCompletedToolPart = (part: MessagePart): boolean => {
  if (!isToolPart(part.type)) return false
  const state = (part as unknown as { state?: unknown }).state
  return typeof state === 'string' && TERMINAL_TOOL_STATES.has(state)
}

// Returns whether a part carries a heavy, unrendered payload eligible for
// stripping: a completed tool output, or a file/binary blob.
const heavyPayloadKind = (part: MessagePart): 'tool' | 'file' | null => {
  const record = part as unknown as Record<string, unknown>
  if (
    isCompletedToolPart(part) &&
    hasContent(record.output) &&
    !isStrippedMarker(record.output)
  ) {
    return 'tool'
  }
  if (
    part.type === 'file' &&
    (hasContent(record.data) || hasContent(record.url))
  ) {
    return 'file'
  }
  return null
}

const stripHeavyPart = (
  part: MessagePart,
  kind: 'tool' | 'file',
): MessagePart => {
  const record = part as unknown as Record<string, unknown>
  if (kind === 'tool') {
    return { ...record, output: { stripped: true } } as unknown as MessagePart
  }
  return {
    ...record,
    data: undefined,
    url: undefined,
  } as unknown as MessagePart
}

/**
 * Cap the number of heavy payloads (completed tool outputs + file blobs)
 * retained across the ENTIRE conversation, including the active message. Walks
 * from newest to oldest, keeps the payload of the last `keepRecent` heavy
 * parts, and replaces older ones with a lightweight marker. The
 * currently-streaming (non-terminal) tool part is never touched, so this is
 * safe to run during streaming. Returns the same array reference when nothing
 * changed.
 */
export function capCompletedToolOutputs(
  messages: UIMessage[],
  keepRecent: number = KEEP_RECENT_TOOL_OUTPUTS,
): UIMessage[] {
  let kept = 0
  let changed = false
  let next: UIMessage[] | null = null

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const message = messages[mi]
    if (!message.parts?.length) continue

    let parts: MessagePart[] | null = null
    for (let pi = message.parts.length - 1; pi >= 0; pi--) {
      const part = message.parts[pi]
      const kind = heavyPayloadKind(part)
      if (!kind) continue
      if (kept < keepRecent) {
        kept++
        continue
      }
      if (!parts) parts = message.parts.slice()
      parts[pi] = stripHeavyPart(part, kind)
      changed = true
    }

    if (parts) {
      if (!next) next = messages.slice()
      next[mi] = { ...message, parts }
    }
  }

  return changed && next ? next : messages
}

// The side panel renders only text, reasoning, and tool name/status (see
// getMessageSegments.ts + ToolBatch.tsx); tool `output` and `file` payloads are
// never shown. Stripping them from old messages frees the base64 screenshots /
// DOM snapshots that dominate memory, with no visible change to scrollback.
const trimOldPart = (part: MessagePart): MessagePart => {
  const type = part.type
  const record = part as unknown as Record<string, unknown>

  if (isToolPart(type)) {
    if (!hasContent(record.output) || isStrippedMarker(record.output)) {
      return part
    }
    return { ...record, output: { stripped: true } } as unknown as MessagePart
  }

  if (type === 'file') {
    if (!hasContent(record.data) && !hasContent(record.url)) return part
    return {
      ...record,
      data: undefined,
      url: undefined,
    } as unknown as MessagePart
  }

  if (type === 'text' || type === 'reasoning') {
    const text = record.text
    if (typeof text !== 'string' || text.length <= MAX_TEXT_PART_CHARS) {
      return part
    }
    return {
      ...record,
      text: `${text.slice(0, MAX_TEXT_PART_CHARS)}${TRUNCATION_MARKER}`,
    } as unknown as MessagePart
  }

  return part
}

/**
 * Bound conversation memory for persistence and post-turn cleanup:
 * 1. Cap heavy payloads globally to the most recent few (capCompletedToolOutputs).
 * 2. Strip any remaining heavy payloads and cap oversized text in messages
 *    older than the recent window.
 * Returns the same array reference when nothing changed so callers can skip
 * redundant state updates and writes.
 */
export function trimConversationMessages(
  messages: UIMessage[],
  keepRecent: number = KEEP_RECENT_MESSAGES,
): UIMessage[] {
  const capped = capCompletedToolOutputs(messages)

  const cutoff = capped.length - keepRecent
  if (cutoff <= 0) return capped

  let changed = false
  const next = capped.map((message, index) => {
    if (index >= cutoff) return message
    if (!message.parts?.length) return message

    let partChanged = false
    const parts = message.parts.map((part) => {
      const trimmed = trimOldPart(part)
      if (trimmed !== part) partChanged = true
      return trimmed
    })

    if (!partChanged) return message
    changed = true
    return { ...message, parts }
  })

  return changed ? next : capped
}
