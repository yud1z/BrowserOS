import type { BrowserOutputFileAccess } from '@browseros/browser-mcp/output-file'
import { SESSION_LIMITS } from '@browseros/shared/constants/limits'
import type { BrowserContext } from '@browseros/shared/schemas/browser-context'
import { logger } from '../lib/logger'
import type { AiSdkAgent } from './ai-sdk-agent'

export interface AgentSession {
  agent: AiSdkAgent
  hiddenPageId?: number
  /** Browser context scoped to the scheduled hidden page. */
  browserContext?: BrowserContext
  /** MCP server names used when the session was created, for change detection. */
  mcpServerKey?: string
  /** Workspace directory when the session was created, for change detection. */
  workingDir?: string
  /** Browser-generated output paths returned during this conversation. */
  outputFileAccess?: BrowserOutputFileAccess
}

export class SessionStore {
  private sessions = new Map<string, AgentSession>()
  private lastAccessedAt = new Map<string, number>()

  get(conversationId: string): AgentSession | undefined {
    const session = this.sessions.get(conversationId)
    if (session) this.lastAccessedAt.set(conversationId, Date.now())
    return session
  }

  set(conversationId: string, session: AgentSession): void {
    this.sessions.set(conversationId, session)
    this.lastAccessedAt.set(conversationId, Date.now())
    logger.info('Session added to store', {
      conversationId,
      totalSessions: this.sessions.size,
    })
    // Bound memory: dispose idle/least-recently-used sessions. Fire-and-forget
    // so the request path isn't blocked on agent disposal.
    void this.evict(conversationId)
  }

  /**
   * Dispose sessions that are idle beyond IDLE_MS, then, if still over
   * MAX_COUNT, dispose the least-recently-used ones. Never evicts `exceptId`
   * (the session just written).
   */
  private async evict(exceptId: string): Promise<void> {
    const now = Date.now()

    const disposeEntry = async (conversationId: string) => {
      const session = this.sessions.get(conversationId)
      if (!session) return
      this.sessions.delete(conversationId)
      this.lastAccessedAt.delete(conversationId)
      try {
        await session.agent.dispose()
      } catch (error) {
        logger.warn('Failed to dispose evicted session', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const idleIds: string[] = []
    for (const [conversationId, accessedAt] of this.lastAccessedAt) {
      if (conversationId === exceptId) continue
      if (now - accessedAt > SESSION_LIMITS.IDLE_MS)
        idleIds.push(conversationId)
    }
    for (const conversationId of idleIds) {
      logger.info('Evicting idle session', { conversationId })
      await disposeEntry(conversationId)
    }

    while (this.sessions.size > SESSION_LIMITS.MAX_COUNT) {
      let lruId: string | undefined
      let lruAccessedAt = Number.POSITIVE_INFINITY
      for (const [conversationId, accessedAt] of this.lastAccessedAt) {
        if (conversationId === exceptId) continue
        if (accessedAt < lruAccessedAt) {
          lruAccessedAt = accessedAt
          lruId = conversationId
        }
      }
      if (!lruId) break
      logger.info('Evicting least-recently-used session', {
        conversationId: lruId,
        totalSessions: this.sessions.size,
      })
      await disposeEntry(lruId)
    }
  }

  has(conversationId: string): boolean {
    return this.sessions.has(conversationId)
  }

  remove(conversationId: string): boolean {
    const existed = this.sessions.delete(conversationId)
    this.lastAccessedAt.delete(conversationId)
    if (existed) {
      logger.info('Session removed from store (without dispose)', {
        conversationId,
        remainingSessions: this.sessions.size,
      })
    }
    return existed
  }

  async delete(conversationId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId)
    if (!session) return false

    await session.agent.dispose()
    this.sessions.delete(conversationId)
    this.lastAccessedAt.delete(conversationId)
    logger.info('Session deleted', {
      conversationId,
      remainingSessions: this.sessions.size,
    })
    return true
  }

  count(): number {
    return this.sessions.size
  }
}
