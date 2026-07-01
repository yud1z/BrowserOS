import type { UIMessage } from 'ai'
import { ArrowDownIcon, Bot } from 'lucide-react'
import { type FC, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'
import { Button } from '@/components/ui/button'
import type { ChatAction } from '@/lib/chat-actions/types'
import { ChatMessageActions } from './ChatMessageActions'
import { ConnectAppCard } from './ConnectAppCard'
import { getMessageSegments } from './getMessageSegments'
import { JtbdPopup } from './JtbdPopup'
import { ScheduleSuggestionCard } from './ScheduleSuggestionCard'
import { ToolBatch } from './ToolBatch'
import { UserActionMessage } from './UserActionMessage'

export interface ChatMessagesProps {
  messages: UIMessage[]
  status: 'streaming' | 'submitted' | 'ready' | 'error'
  getActionForMessage?: (message: UIMessage) => ChatAction | undefined
  liked: Record<string, boolean>
  onClickLike: (messageId: string) => void
  disliked: Record<string, boolean>
  onClickDislike: (messageId: string, comment?: string) => void
  showJtbdPopup: boolean
  showDontShowAgain: boolean
  onTakeSurvey: (opts?: { dontShowAgain?: boolean }) => void
  onDismissJtbdPopup: (dontShowAgain: boolean) => void
}

export const ChatMessages: FC<ChatMessagesProps> = ({
  messages,
  status,
  getActionForMessage,
  liked,
  disliked,
  onClickLike,
  onClickDislike,
  showJtbdPopup,
  showDontShowAgain,
  onTakeSurvey,
  onDismissJtbdPopup,
}) => {
  const isStreaming = status === 'streaming' || status === 'submitted'
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)

  // Only the visible window of messages is mounted (react-virtuoso). Rendering
  // every message + tool batch on each streaming token grows the DOM/fiber
  // tree without bound and, on long multi-task sessions, wedges and OOMs the
  // extension renderer. Virtualization keeps per-render work ~O(visible).
  const renderMessage = (index: number, message: UIMessage) => {
    const action = getActionForMessage?.(message)
    const isLastMessage = index === messages.length - 1
    const segments = getMessageSegments(message, isLastMessage, isStreaming)
    const toolBatches = segments.filter((s) => s.type === 'tool-batch')
    const lastToolBatchKey = toolBatches[toolBatches.length - 1]?.key

    const messageText = segments
      ?.filter((each) => each.type === 'text')
      ?.map((each) => each.text)
      ?.join('\n\n')

    const likeAction = () => onClickLike(message.id)
    const dislikeAction = (comment?: string) =>
      onClickDislike(message.id, comment)

    return (
      <div className="px-4 pb-8 first:pt-4">
        <Message from={message.role}>
          <MessageContent>
            {action ? (
              <UserActionMessage action={action} />
            ) : (
              segments.map((segment) => {
                switch (segment.type) {
                  case 'text':
                    return (
                      <MessageResponse key={segment.key}>
                        {segment.text}
                      </MessageResponse>
                    )
                  case 'reasoning':
                    return (
                      <Reasoning
                        key={segment.key}
                        className="w-full"
                        isStreaming={segment.isStreaming}
                      >
                        <ReasoningTrigger />
                        <ReasoningContent>{segment.text}</ReasoningContent>
                      </Reasoning>
                    )
                  case 'tool-batch':
                    return (
                      <ToolBatch
                        key={segment.key}
                        tools={segment.tools}
                        isLastBatch={segment.key === lastToolBatchKey}
                        isLastMessage={isLastMessage}
                        isStreaming={isStreaming}
                      />
                    )
                  case 'nudge':
                    return segment.nudgeType === 'schedule_suggestion' ? (
                      <ScheduleSuggestionCard
                        key={segment.key}
                        data={segment.data}
                        isLastMessage={isLastMessage}
                      />
                    ) : (
                      <ConnectAppCard
                        key={segment.key}
                        data={segment.data}
                        isLastMessage={isLastMessage}
                      />
                    )
                  default:
                    return null
                }
              })
            )}
          </MessageContent>
        </Message>
        {message.role === 'assistant' && (!isLastMessage || !isStreaming) ? (
          <ChatMessageActions
            messageId={message.id}
            messageText={messageText}
            liked={liked[message.id] ?? false}
            disliked={disliked[message.id] ?? false}
            onClickLike={likeAction}
            onClickDislike={dislikeAction}
          />
        ) : null}
      </div>
    )
  }

  const Footer = () => (
    <>
      {showJtbdPopup && (
        <div className="px-4 pb-4">
          <JtbdPopup
            onTakeSurvey={onTakeSurvey}
            onDismiss={onDismissJtbdPopup}
            showDontShowAgain={showDontShowAgain}
          />
        </div>
      )}
      {isStreaming && (
        <div className="flex animate-fadeInUp gap-2 px-3 pb-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-orange)] text-white">
            <Bot className="h-3.5 w-3.5" />
          </div>
          <div className="flex items-center gap-1 rounded-xl rounded-tl-none border border-border/50 bg-card px-3 py-2.5 shadow-sm">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--accent-orange)] [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--accent-orange)] [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--accent-orange)]" />
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Virtuoso
        ref={virtuosoRef}
        className="ph-mask styled-scrollbar"
        style={{ flex: 1 }}
        data={messages}
        computeItemKey={(_index, message) => message.id}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        followOutput={(isAtBottom) => (isAtBottom ? 'smooth' : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={80}
        increaseViewportBy={{ top: 800, bottom: 800 }}
        itemContent={renderMessage}
        components={{ Footer }}
      />
      {!atBottom && (
        <Button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({
              index: 'LAST',
              behavior: 'smooth',
            })
          }
          size="icon"
          type="button"
          variant="outline"
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      )}
    </div>
  )
}
