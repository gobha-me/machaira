import { randomUUID } from 'node:crypto'
import type { ChatInput, ChatRole } from './ai.js'
import type { MachairaDatabase } from './database.js'

export type ChatMessageStatus = 'streaming' | 'completed' | 'interrupted' | 'failed'

export interface ChatPassage {
  reference: string
  module: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  status: ChatMessageStatus
  replyToMessageId: string | null
  passage: ChatPassage | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface ChatConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ChatConversation extends ChatConversationSummary {
  messages: ChatMessage[]
}

interface ConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  conversation_id: string
  sequence: number
  role: ChatRole
  content: string
  status: ChatMessageStatus
  reply_to_message_id: string | null
  passage_reference: string | null
  passage_module: string | null
  passage_content: string | null
  error: string | null
  created_at: number
  updated_at: number
}

interface Preferences {
  alwaysCite: boolean
  drawApocrypha: boolean
}

interface NewTurnInput {
  content: string
  passage: { reference: string; module: string; content: string }
  preferences: Preferences
}

export interface StartedChat {
  conversation: ChatConversationSummary
  userMessage: ChatMessage | null
  assistantMessage: ChatMessage
  providerInput: ChatInput
}

export class ChatInputError extends Error {}
export class ChatNotFoundError extends Error {}
export class ChatConflictError extends Error {}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatInputError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ChatInputError(`${label} is required`)
  const result = value.trim()
  if (result.length > max) throw new ChatInputError(`${label} is too long`)
  return result
}

function preferences(value: unknown): Preferences {
  const input = value === undefined ? {} : record(value, 'Preferences')
  if (input.alwaysCite !== undefined && typeof input.alwaysCite !== 'boolean') {
    throw new ChatInputError('alwaysCite must be a boolean')
  }
  if (input.drawApocrypha !== undefined && typeof input.drawApocrypha !== 'boolean') {
    throw new ChatInputError('drawApocrypha must be a boolean')
  }
  return {
    alwaysCite: input.alwaysCite !== false,
    drawApocrypha: input.drawApocrypha === true
  }
}

function newTurn(value: unknown): NewTurnInput {
  const input = record(value, 'Chat message')
  const passage = record(input.passage, 'Passage context')
  return {
    content: text(input.content, 'Message', 12_000),
    passage: {
      reference: text(passage.reference, 'Passage reference', 300),
      module: text(passage.module, 'Passage module', 200),
      content: text(passage.content, 'Passage content', 30_000)
    },
    preferences: preferences(input.preferences)
  }
}

function retryInput(value: unknown): Preferences {
  const input = value === undefined ? {} : record(value, 'Retry')
  return preferences(input.preferences)
}

function summary(row: ConversationRow): ChatConversationSummary {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
}

function message(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    replyToMessageId: row.reply_to_message_id,
    passage: row.passage_reference && row.passage_module
      ? { reference: row.passage_reference, module: row.passage_module }
      : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function initialTitle(question: string): string {
  const collapsed = question.replace(/\s+/g, ' ').trim()
  const characters = Array.from(collapsed)
  return characters.length <= 80 ? collapsed : `${characters.slice(0, 79).join('')}…`
}

function providerUserContent(row: MessageRow): string {
  return `[Passage: ${row.passage_reference} · ${row.passage_module}]\n${row.content}`
}

export class ChatConversationService {
  constructor(private readonly db: MachairaDatabase) {
    const now = Date.now()
    db.transaction(() => {
      db.prepare(`
        UPDATE chat_conversations SET updated_at = ? WHERE id IN (
          SELECT DISTINCT conversation_id FROM chat_messages
          WHERE role = 'assistant' AND status = 'streaming'
        )
      `).run(now)
      db.prepare(`
        UPDATE chat_messages SET status = 'interrupted', error = ?, updated_at = ?
        WHERE role = 'assistant' AND status = 'streaming'
      `).run('Response interrupted by a server restart', now)
    })()
  }

  list(userId: string): ChatConversationSummary[] {
    const rows = this.db.prepare(`
      SELECT id, title, created_at, updated_at FROM chat_conversations
      WHERE user_id = ? ORDER BY updated_at DESC, id
    `).all(userId) as ConversationRow[]
    return rows.map(summary)
  }

  create(userId: string): ChatConversation {
    const now = Date.now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO chat_conversations (id, user_id, title, created_at, updated_at)
      VALUES (?, ?, 'New chat', ?, ?)
    `).run(id, userId, now, now)
    return { id, title: 'New chat', createdAt: now, updatedAt: now, messages: [] }
  }

  get(userId: string, id: string): ChatConversation | null {
    const row = this.conversationRow(userId, id)
    if (!row) return null
    const rows = this.messageRows(id)
    return { ...summary(row), messages: rows.map(message) }
  }

  rename(userId: string, id: string, value: unknown): ChatConversationSummary | null {
    const existing = this.conversationRow(userId, id)
    if (!existing) return null
    const input = record(value, 'Conversation')
    const title = text(input.title, 'Conversation title', 120)
    const now = Date.now()
    const changed = this.db.prepare(`
      UPDATE chat_conversations SET title = ?, updated_at = ? WHERE user_id = ? AND id = ?
    `).run(title, now, userId, text(id, 'Conversation id', 128)).changes
    if (!changed) return null
    return summary(this.conversationRow(userId, id)!)
  }

  delete(userId: string, id: string): boolean {
    if (!this.conversationRow(userId, id)) return false
    this.assertIdle(id)
    return this.db.prepare('DELETE FROM chat_conversations WHERE user_id = ? AND id = ?')
      .run(userId, text(id, 'Conversation id', 128)).changes > 0
  }

  assertOwned(userId: string, id: string): void {
    this.requiredConversation(userId, id)
  }

  startTurn(userId: string, conversationId: string, value: unknown): StartedChat {
    const conversation = this.requiredConversation(userId, conversationId)
    const input = newTurn(value)
    this.assertIdle(conversationId)
    const now = Date.now()
    const userIdValue = randomUUID()
    const assistantId = randomUUID()

    this.db.transaction(() => {
      const sequence = this.nextSequence(conversationId)
      this.db.prepare(`
        INSERT INTO chat_messages
          (id, conversation_id, sequence, role, content, status, reply_to_message_id,
           passage_reference, passage_module, passage_content, error, created_at, updated_at)
        VALUES (?, ?, ?, 'user', ?, 'completed', NULL, ?, ?, ?, NULL, ?, ?)
      `).run(
        userIdValue, conversationId, sequence, input.content, input.passage.reference,
        input.passage.module, input.passage.content, now, now
      )
      this.db.prepare(`
        INSERT INTO chat_messages
          (id, conversation_id, sequence, role, content, status, reply_to_message_id,
           passage_reference, passage_module, passage_content, error, created_at, updated_at)
        VALUES (?, ?, ?, 'assistant', '', 'streaming', ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(assistantId, conversationId, sequence + 1, userIdValue, now, now)
      const userCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ? AND role = 'user'
      `).get(conversationId) as { count: number }
      const title = userCount.count === 1 ? initialTitle(input.content) : conversation.title
      this.db.prepare(`
        UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?
      `).run(title, now, conversationId)
    })()

    return this.started(userId, conversationId, assistantId, userIdValue, input.preferences)
  }

  startRetry(
    userId: string,
    conversationId: string,
    assistantMessageId: string,
    value: unknown
  ): StartedChat {
    this.requiredConversation(userId, conversationId)
    const retryPreferences = retryInput(value)
    this.assertIdle(conversationId)
    const safeMessageId = text(assistantMessageId, 'Message id', 128)
    const prior = this.db.prepare(`
      SELECT * FROM chat_messages
      WHERE conversation_id = ? AND id = ? AND role = 'assistant'
    `).get(conversationId, safeMessageId) as MessageRow | undefined
    if (!prior) throw new ChatNotFoundError('Message not found')
    if (prior.status !== 'failed' && prior.status !== 'interrupted') {
      throw new ChatConflictError('Only a failed or interrupted response can be retried')
    }
    const latestUser = this.db.prepare(`
      SELECT id FROM chat_messages
      WHERE conversation_id = ? AND role = 'user' ORDER BY sequence DESC LIMIT 1
    `).get(conversationId) as { id: string } | undefined
    if (!latestUser || prior.reply_to_message_id !== latestUser.id) {
      throw new ChatConflictError('Only the latest unresolved turn can be retried')
    }
    const latestAttempt = this.db.prepare(`
      SELECT id FROM chat_messages
      WHERE conversation_id = ? AND reply_to_message_id = ? AND role = 'assistant'
      ORDER BY sequence DESC LIMIT 1
    `).get(conversationId, latestUser.id) as { id: string } | undefined
    if (latestAttempt?.id !== prior.id) {
      throw new ChatConflictError('Only the latest response attempt can be retried')
    }
    const laterCompleted = this.db.prepare(`
      SELECT 1 FROM chat_messages
      WHERE conversation_id = ? AND reply_to_message_id = ? AND role = 'assistant'
        AND status = 'completed' AND sequence > ? LIMIT 1
    `).get(conversationId, latestUser.id, prior.sequence)
    if (laterCompleted) throw new ChatConflictError('This turn already has a completed response')

    const now = Date.now()
    const assistantId = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO chat_messages
          (id, conversation_id, sequence, role, content, status, reply_to_message_id,
           passage_reference, passage_module, passage_content, error, created_at, updated_at)
        VALUES (?, ?, ?, 'assistant', '', 'streaming', ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(assistantId, conversationId, this.nextSequence(conversationId), latestUser.id, now, now)
      this.db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?')
        .run(now, conversationId)
    })()
    return this.started(userId, conversationId, assistantId, null, retryPreferences)
  }

  appendDelta(userId: string, conversationId: string, assistantId: string, delta: string): ChatMessage {
    this.requiredConversation(userId, conversationId)
    const now = Date.now()
    const changed = this.db.prepare(`
      UPDATE chat_messages SET content = content || ?, updated_at = ?
      WHERE conversation_id = ? AND id = ? AND role = 'assistant' AND status = 'streaming'
    `).run(delta, now, conversationId, assistantId).changes
    if (!changed) throw new ChatConflictError('Response is no longer streaming')
    return message(this.requiredMessage(conversationId, assistantId))
  }

  complete(userId: string, conversationId: string, assistantId: string): ChatMessage {
    return this.finish(userId, conversationId, assistantId, 'completed', null)
  }

  fail(
    userId: string,
    conversationId: string,
    assistantId: string,
    status: Extract<ChatMessageStatus, 'interrupted' | 'failed'>,
    error: string
  ): ChatMessage {
    return this.finish(userId, conversationId, assistantId, status, error.slice(0, 2000))
  }

  private finish(
    userId: string,
    conversationId: string,
    assistantId: string,
    status: Exclude<ChatMessageStatus, 'streaming'>,
    error: string | null
  ): ChatMessage {
    this.requiredConversation(userId, conversationId)
    const now = Date.now()
    const changed = this.db.prepare(`
      UPDATE chat_messages SET status = ?, error = ?, updated_at = ?
      WHERE conversation_id = ? AND id = ? AND role = 'assistant' AND status = 'streaming'
    `).run(status, error, now, conversationId, assistantId).changes
    if (!changed) return message(this.requiredMessage(conversationId, assistantId))
    this.db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?')
      .run(now, conversationId)
    return message(this.requiredMessage(conversationId, assistantId))
  }

  private started(
    userId: string,
    conversationId: string,
    assistantId: string,
    userMessageId: string | null,
    selectedPreferences: Preferences
  ): StartedChat {
    const assistantRow = this.requiredMessage(conversationId, assistantId)
    const targetUser = this.requiredMessage(conversationId, assistantRow.reply_to_message_id!)
    if (!targetUser.passage_reference || !targetUser.passage_module || !targetUser.passage_content) {
      throw new ChatConflictError('The user turn has no passage context')
    }
    const rows = this.providerHistory(conversationId, targetUser.id)
    return {
      conversation: summary(this.requiredConversation(userId, conversationId)),
      userMessage: userMessageId ? message(this.requiredMessage(conversationId, userMessageId)) : null,
      assistantMessage: message(assistantRow),
      providerInput: {
        passage: {
          reference: targetUser.passage_reference,
          module: targetUser.passage_module,
          content: targetUser.passage_content
        },
        messages: rows.map((row) => ({
          role: row.role,
          content: row.role === 'user' ? providerUserContent(row) : row.content
        })),
        preferences: selectedPreferences
      }
    }
  }

  private providerHistory(conversationId: string, targetUserId: string): MessageRow[] {
    const rows = this.messageRows(conversationId)
    const target = rows.find((row) => row.id === targetUserId && row.role === 'user')
    if (!target) throw new ChatNotFoundError('User turn not found')
    const latestCompleted = new Map<string, MessageRow>()
    for (const row of rows) {
      if (row.sequence >= target.sequence) break
      if (row.role === 'assistant' && row.status === 'completed' && row.reply_to_message_id) {
        latestCompleted.set(row.reply_to_message_id, row)
      }
    }
    const eligible: MessageRow[] = []
    for (const user of rows.filter((row) => row.role === 'user' && row.sequence <= target.sequence)) {
      if (user.id === target.id) {
        eligible.push(user)
        continue
      }
      const completed = latestCompleted.get(user.id)
      if (completed) eligible.push(user, completed)
    }
    const limited = eligible.slice(-20)
    while (limited[0]?.role === 'assistant') limited.shift()
    return limited
  }

  private assertIdle(conversationId: string): void {
    const active = this.db.prepare(`
      SELECT 1 FROM chat_messages
      WHERE conversation_id = ? AND role = 'assistant' AND status = 'streaming' LIMIT 1
    `).get(conversationId)
    if (active) throw new ChatConflictError('A response is already streaming for this conversation')
  }

  private nextSequence(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM chat_messages WHERE conversation_id = ?
    `).get(conversationId) as { sequence: number }
    return row.sequence
  }

  private conversationRow(userId: string, id: string): ConversationRow | null {
    const safeId = text(id, 'Conversation id', 128)
    return (this.db.prepare(`
      SELECT id, title, created_at, updated_at FROM chat_conversations
      WHERE user_id = ? AND id = ?
    `).get(userId, safeId) as ConversationRow | undefined) ?? null
  }

  private requiredConversation(userId: string, id: string): ConversationRow {
    const row = this.conversationRow(userId, id)
    if (!row) throw new ChatNotFoundError('Conversation not found')
    return row
  }

  private messageRows(conversationId: string): MessageRow[] {
    return this.db.prepare(`
      SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY sequence
    `).all(conversationId) as MessageRow[]
  }

  private requiredMessage(conversationId: string, id: string): MessageRow {
    const row = this.db.prepare(`
      SELECT * FROM chat_messages WHERE conversation_id = ? AND id = ?
    `).get(conversationId, id) as MessageRow | undefined
    if (!row) throw new ChatNotFoundError('Message not found')
    return row
  }
}
