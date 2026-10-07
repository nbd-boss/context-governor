import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import {
  type HistoryIndex,
  type IndexedEventKind,
  parseEventId,
} from '../evidence/history-index.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'

/** Fixed, small evidence-navigation window; raw History remains on demand. */
export const RECENT_TOOL_RESULTS_LIMIT = 8

export const LIST_RECENT_TOOL_RESULTS_DESCRIPTION = `List the ${String(RECENT_TOOL_RESULTS_LIMIT)} newest tool-result navigation records that are still visible in the current Context Epoch. This is evidence navigation only, not semantic search or a general History browser. When a task_plan Step forms a reusable conclusion, use these just-observed results to select one to four direct event-N references before advance_task_progress; do not postpone evidence selection until terminal bookkeeping. Old Epoch results are deliberately excluded; use read_sub_state first when their detail is needed.`

interface SessionEventLike {
  seq: number
  type: string
  data?: unknown
}

interface ToolCallProvenance {
  call_event_id: string
  tool_name: string
  arguments: Record<string, unknown>
  is_error: boolean
}

const SENSITIVE_ARGUMENT_KEY = /(?:api[-_]?key|authorization|credential|cookie|password|secret|token)/i
const MAX_ARGUMENT_DEPTH = 3
const MAX_ARGUMENT_ENTRIES = 12
const MAX_ARGUMENT_TEXT_LENGTH = 160

interface ActiveSession {
  id: string
  snapshotEvents(): readonly SessionEventLike[]
  surface: { nodes: readonly number[] }
}

function sessionFromExecution(exec: { agent?: { session: unknown } }): ActiveSession {
  if (exec.agent === undefined) {
    throw new Error('History tools require an active Session.')
  }
  return exec.agent.session as ActiveSession
}

function eventFromId(
  events: readonly SessionEventLike[],
  id: string,
): { seq: number } {
  const seq = parseEventId(id)
  if (seq === undefined) throw new Error(`Invalid History event id: ${id}`)
  const event = events.find(candidate => candidate.seq === seq)
  if (event === undefined) throw new Error(`History event not found: ${id}`)
  return event
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function truncate(text: string): string {
  return text.length <= MAX_ARGUMENT_TEXT_LENGTH ? text : `${text.slice(0, MAX_ARGUMENT_TEXT_LENGTH)}…`
}

function safeArgumentValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return truncate(value)
  if (depth >= MAX_ARGUMENT_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, MAX_ARGUMENT_ENTRIES).map(item => safeArgumentValue(item, depth + 1))
  const record = asRecord(value)
  if (record === undefined) return String(value)
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record).slice(0, MAX_ARGUMENT_ENTRIES)) {
    if (!SENSITIVE_ARGUMENT_KEY.test(key)) output[key] = safeArgumentValue(item, depth + 1)
  }
  return output
}

function safeArguments(raw: unknown): Record<string, unknown> {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { value: truncate(raw) }
    }
  }
  const sanitized = safeArgumentValue(parsed, 0)
  return asRecord(sanitized) ?? { value: sanitized }
}

function toolResultCallId(event: SessionEventLike): string | undefined {
  const data = asRecord(event.data)
  const message = asRecord(data?.message)
  const source = asRecord(message?.source)
  const value = source?.callId ?? data?.callId
  return typeof value === 'string' ? value : undefined
}

function toolResultIsError(event: SessionEventLike): boolean {
  const data = asRecord(event.data)
  if (data?.isError === true) return true
  const message = asRecord(data?.message)
  const content = message?.content
  return Array.isArray(content) && content.some(block => asRecord(block)?.isError === true)
}

/**
 * Add only call-level provenance to tool results. Raw tool-result content stays
 * in the Session log and remains available solely through prior-Epoch read tools.
 */
export function enrichHistoryNavigation(
  entries: readonly { id: string; kind: IndexedEventKind }[],
  events: readonly SessionEventLike[],
): Array<{ id: string; kind: IndexedEventKind } & Partial<ToolCallProvenance>> {
  const calls = new Map<string, { seq: number; name: string; arguments: unknown }>()
  const results = new Map<number, SessionEventLike>()
  for (const event of events) {
    const data = asRecord(event.data)
    if (event.type === 'tool/call') {
      const callId = data?.callId
      const name = data?.name
      if (typeof callId === 'string' && typeof name === 'string') {
        calls.set(callId, { seq: event.seq, name, arguments: data?.arguments })
      }
    } else if (event.type === 'tool/result') {
      results.set(event.seq, event)
    }
  }
  return entries.map(entry => {
    if (entry.kind !== 'tool_result') return entry
    const result = results.get(parseEventId(entry.id) ?? -1)
    const call = result === undefined ? undefined : calls.get(toolResultCallId(result) ?? '')
    if (call === undefined || result === undefined) return entry
    return {
      ...entry,
      call_event_id: `event-${String(call.seq)}`,
      tool_name: call.name,
      arguments: safeArguments(call.arguments),
      is_error: toolResultIsError(result),
    }
  })
}

/**
 * Return a bounded evidence-navigation view for the just-completed work.
 * Callers cannot widen this window or request arbitrary History kinds.
 */
/** The Session surface, rather than a Governor sidecar, is the visibility authority. */
export function visibleEventSequences(session: ActiveSession): ReadonlySet<number> {
  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes) || nodes.some(seq => !Number.isSafeInteger(seq))) {
    throw new Error('Context visibility is unavailable; raw History reads are disabled.')
  }
  return new Set(nodes)
}

/** Reject duplication of an event the model can already see in this Epoch. */
export function requirePriorEpochEvent(id: string, visibleSequences: ReadonlySet<number>): void {
  const seq = parseEventId(id)
  if (seq !== undefined && visibleSequences.has(seq)) {
    throw new Error(JSON.stringify({
      status: 'rejected',
      error_code: 'CURRENT_EPOCH_EVENT_ALREADY_VISIBLE',
      target: id,
      repair: 'Use the current Context History directly. Call list_recent_tool_results only when the event-N identifier is needed.',
      retry_allowed: false,
    }))
  }
}

export function visibleRecentToolResultNavigation(
  index: HistoryIndex,
  sessionId: string,
  events: readonly SessionEventLike[],
  visibleSequences: ReadonlySet<number>,
): Array<{ id: string; kind: IndexedEventKind } & Partial<ToolCallProvenance>> {
  const entries = index.entries(sessionId)
    .filter(entry => entry.kind === 'tool_result' && visibleSequences.has(parseEventId(entry.id) ?? -1))
    .slice(-RECENT_TOOL_RESULTS_LIMIT)
    .reverse()
  return enrichHistoryNavigation(
    entries,
    events,
  )
}

/** Register the phase-two read-only History tools. */
export function registerHistoryTools(ctx: Context, index: HistoryIndex, workspaces: SessionWorkspaceProvider): void {
  ctx.tools.register(defineTool({
    name: 'list_recent_tool_results',
    description: `${LIST_RECENT_TOOL_RESULTS_DESCRIPTION} Each result includes its paired call event, tool name, safely bounded call arguments, and error status when available; raw tool-result text is never included.`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                call_event_id: { type: 'string' },
                tool_name: { type: 'string' },
                arguments: { type: 'object', additionalProperties: true },
                is_error: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const session = sessionFromExecution(exec)
      return {
        entries: visibleRecentToolResultNavigation(
          index,
          session.id,
          session.snapshotEvents(),
          visibleEventSequences(session),
        ),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_prior_epoch_event',
    description: 'Read one complete raw DSH History event from this Session that is no longer visible in the current Context Epoch. First use read_sub_state to locate an older SubStep source event. Current-Epoch events are already in the model Context and are rejected rather than duplicated.',
    parameters: {
      id: { type: 'string', required: true, description: 'A no-longer-visible event-N identifier from a SubStep source_events reference.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const session = sessionFromExecution(exec)
      const event = eventFromId(session.snapshotEvents(), args.id)
      requirePriorEpochEvent(args.id, visibleEventSequences(session))
      await workspaces.forSession(session.id).audits.recordRead(session.id, { kind: 'event', target: args.id })
      return JSON.stringify(event)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_prior_epoch_range',
    description: 'Read a bounded inclusive range of raw DSH History events from this Session that are no longer visible in the current Context Epoch. Use this only after a SubState points to an older span whose detail is needed. Any range containing a current-Epoch event is rejected rather than duplicated.',
    parameters: {
      start_id: { type: 'string', required: true, description: 'First event-N identifier to include.' },
      end_id: { type: 'string', required: true, description: 'Last event-N identifier to include.' },
      limit: { type: 'integer', description: 'Maximum events to return (1-100, default 20).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const session = sessionFromExecution(exec)
      const events = session.snapshotEvents()
      const start = eventFromId(events, args.start_id).seq
      const end = eventFromId(events, args.end_id).seq
      if (start > end) throw new Error('start_id must not come after end_id')
      const visibleSequences = visibleEventSequences(session)
      for (const event of events) {
        if (event.seq >= start && event.seq <= end) requirePriorEpochEvent(`event-${String(event.seq)}`, visibleSequences)
      }
      const limit = Math.max(1, Math.min(Math.trunc(args.limit ?? 20), 100))
      await workspaces.forSession(session.id).audits.recordRead(session.id, { kind: 'event_range', target: `${args.start_id}..${args.end_id}` })
      return JSON.stringify(events.filter(event => event.seq >= start && event.seq <= end).slice(0, limit))
    },
  }))
}
