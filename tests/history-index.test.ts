import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import type { AuditRead } from '../src/evidence/audit-contract.ts'
import type { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { HistoryIndex, parseEventId } from '../src/evidence/history-index.ts'
import {
  enrichHistoryNavigation,
  LIST_RECENT_TOOL_RESULTS_DESCRIPTION,
  RECENT_TOOL_RESULTS_LIMIT,
  registerHistoryTools,
  requirePriorEpochEvent,
  visibleRecentToolResultNavigation,
} from '../src/tools/history-tools.ts'

test('one History reader supports a single event and a range, with visibility checks and auditing', async () => {
  const tools: ToolDefinition[] = []
  const reads: AuditRead[] = []
  const events = [
    { seq: 10, type: 'tool/call', data: { name: 'list_orders' } },
    { seq: 11, type: 'tool/result', data: { orders: [101, 102] } },
    { seq: 20, type: 'user/message', data: { text: 'Current Epoch.' } },
  ]
  const session = { id: 'session-1', snapshotEvents: () => events, surface: { nodes: [20] } }
  const workspaces = { forSession: (id: string) => {
    assert.equal(id, session.id)
    return { audits: { recordRead: async (_sessionId: string, read: AuditRead) => { reads.push(read) } } }
  } } as unknown as SessionWorkspaceProvider
  registerHistoryTools({ tools: { register: tool => { tools.push(tool) } } } as unknown as Context, new HistoryIndex(), workspaces)
  assert.deepEqual(tools.map(tool => tool.name), ['list_recent_tool_results', 'read_prior_epoch_range'])
  const reader = tools.find(tool => tool.name === 'read_prior_epoch_range')!
  const exec = { agent: { session } } as never

  assert.deepEqual(JSON.parse(await reader.execute({ start_id: 'event-11', end_id: 'event-11' }, exec) as string), [events[1]])
  assert.deepEqual(JSON.parse(await reader.execute({ start_id: 'event-10', end_id: 'event-11' }, exec) as string), events.slice(0, 2))
  assert.deepEqual(reads, [
    { kind: 'event', target: 'event-11' },
    { kind: 'event_range', target: 'event-10..event-11' },
  ])
  await assert.rejects(reader.execute({ start_id: 'event-11', end_id: 'event-20' }, exec), /CURRENT_EPOCH_EVENT_ALREADY_VISIBLE/)
  await assert.rejects(reader.execute({ start_id: 'event-10', end_id: 'event-99' }, exec), /not found/)
  assert.equal(reads.length, 2)
})

test('History reads preserve external-result references without fetching files or reconstructing omitted content', async () => {
  const tools: ToolDefinition[] = []
  const event = { seq: 1, type: 'tool/result', data: { message: { content: [{ type: 'text', text: '(Omitted 1000 bytes. Full formatted result stored at: E:\\runtime\\result.txt)' }] } } }
  const session = { id: 'session-1', snapshotEvents: () => [event], surface: { nodes: [] } }
  const workspaces = { forSession: () => ({ audits: { recordRead: async () => {} } }) } as unknown as SessionWorkspaceProvider
  registerHistoryTools({ tools: { register: tool => { tools.push(tool) } } } as unknown as Context, new HistoryIndex(), workspaces)
  const reader = tools.find(tool => tool.name === 'read_prior_epoch_range')!
  assert.match(reader.description, /stored event representation, not externalized result files/)
  assert.match(reader.description, /context_governor\.retrieval_policy\.raw_history/)
  const output = await reader.execute({ start_id: 'event-1', end_id: 'event-1' }, { agent: { session } } as never)
  assert.deepEqual(JSON.parse(output as string), [event])
})

test('rebuilds only the four MVP event kinds without copying raw text', () => {
  const index = new HistoryIndex()
  index.rebuild('session-1', [
    { seq: 0, type: 'turn/start' },
    { seq: 1, type: 'user/message' },
    { seq: 2, type: 'tool/call' },
    { seq: 3, type: 'tool/result' },
    { seq: 4, type: 'assistant/message' },
    { seq: 5, type: 'turn/end' },
  ])

  assert.deepEqual(index.entries('session-1'), [
    { id: 'event-1', kind: 'user_message' },
    { id: 'event-2', kind: 'tool_call' },
    { id: 'event-3', kind: 'tool_result' },
    { id: 'event-4', kind: 'assistant_message' },
  ])
})

test('appends idempotently and lists newest entries without relevance claims', () => {
  const index = new HistoryIndex()
  index.append('session-1', { seq: 7, type: 'user/message' })
  index.append('session-1', { seq: 7, type: 'user/message' })
  index.append('session-1', { seq: 8, type: 'assistant/message' })

  assert.deepEqual(index.list('session-1', undefined, 10), [
    { id: 'event-8', kind: 'assistant_message' },
    { id: 'event-7', kind: 'user_message' },
  ])
  assert.equal(parseEventId('event-8'), 8)
  assert.equal(parseEventId('event-08'), undefined)
})

test('documents fixed small evidence navigation rather than terminal History reconstruction', () => {
  assert.equal(RECENT_TOOL_RESULTS_LIMIT, 8)
  assert.match(LIST_RECENT_TOOL_RESULTS_DESCRIPTION, /8 newest tool-result/)
  assert.match(LIST_RECENT_TOOL_RESULTS_DESCRIPTION, /advance_task_progress/)
  assert.match(LIST_RECENT_TOOL_RESULTS_DESCRIPTION, /do not postpone/)
})

test('limits recent evidence navigation to eight tool results', () => {
  const index = new HistoryIndex()
  const events = Array.from({ length: 18 }, (_value, index) => {
    const seq = index + 1
    return seq % 2 === 1
      ? { seq, type: 'tool/call', data: { callId: `call-${String(seq)}`, name: 'canvas_list_courses', arguments: { page: seq } } }
      : { seq, type: 'tool/result', data: { message: { role: 'tool', toolCallId: `call-${String(seq - 1)}`, content: [] } } }
  })
  index.rebuild('session-1', events)

  const entries = visibleRecentToolResultNavigation(
    index,
    'session-1',
    events,
    new Set(events.map(event => event.seq)),
  )
  assert.equal(entries.length, RECENT_TOOL_RESULTS_LIMIT)
  assert.deepEqual(entries.map(entry => entry.id), [
    'event-18', 'event-16', 'event-14', 'event-12',
    'event-10', 'event-8', 'event-6', 'event-4',
  ])
  assert.equal(entries.every(entry => entry.kind === 'tool_result'), true)
})

test('lists only tool results still visible in the current Context Epoch', () => {
  const index = new HistoryIndex()
  const events = [
    { seq: 10, type: 'tool/call', data: { callId: 'call-10', name: 'canvas_list_courses' } },
    { seq: 11, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-10', content: [] } } },
    { seq: 20, type: 'tool/call', data: { callId: 'call-20', name: 'canvas_list_assignments' } },
    { seq: 21, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-20', content: [] } } },
  ]
  index.rebuild('session-1', events)

  const entries = visibleRecentToolResultNavigation(index, 'session-1', events, new Set([20, 21]))
  assert.deepEqual(entries.map(entry => entry.id), ['event-21'])
})

test('rejects raw History reads for events still visible in the current Context Epoch', () => {
  assert.throws(
    () => requirePriorEpochEvent('event-21', new Set([20, 21])),
    /CURRENT_EPOCH_EVENT_ALREADY_VISIBLE/,
  )
  assert.doesNotThrow(() => requirePriorEpochEvent('event-11', new Set([20, 21])))
})

test('adds safe call provenance to tool results without copying raw result text', () => {
  const entries = enrichHistoryNavigation([
    { id: 'event-2', kind: 'tool_call' },
    { id: 'event-3', kind: 'tool_result' },
  ], [
    { seq: 2, type: 'tool/call', data: { callId: 'call-1', name: 'mcp__canvas__canvas_list_quizzes', arguments: '{"course_id":4,"api_token":"remove-me","nested":{"text":"x"}}' } },
    { seq: 3, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'private quiz result body' }] } } },
  ])
  assert.deepEqual(entries, [
    { id: 'event-2', kind: 'tool_call' },
    { id: 'event-3', kind: 'tool_result', call_event_id: 'event-2', tool_name: 'mcp__canvas__canvas_list_quizzes', arguments: { course_id: 4, nested: { text: 'x' } }, is_error: false },
  ])
  assert.doesNotMatch(JSON.stringify(entries), /remove-me|private quiz result body/)
})

test('reads failure status from the DSH tool message rather than content blocks', () => {
  for (const isError of [true, false, undefined]) {
    const entries = enrichHistoryNavigation([{ id: 'event-3', kind: 'tool_result' }], [
      { seq: 2, type: 'tool/call', data: { callId: 'call-1', name: 'read_source', arguments: {} } },
      { seq: 3, type: 'tool/result', data: { message: {
        role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: 'Result text must not determine success.' }],
        ...(isError === undefined ? {} : { isError }),
      } } },
    ])
    assert.equal(entries[0]!.is_error, isError === true)
    assert.equal(entries[0]!.call_event_id, 'event-2')
  }
})
