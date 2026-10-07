/** The only event types indexed in the phase-two MVP. */
export type IndexedEventKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'

export interface RawHistoryEvent {
  seq: number
  type: string
}

export interface HistoryIndexEntry {
  id: string
  kind: IndexedEventKind
}

interface IndexedHistoryEvent extends HistoryIndexEntry {
  seq: number
}

const EVENT_KINDS: Record<string, IndexedEventKind | undefined> = {
  'user/message': 'user_message',
  'assistant/message': 'assistant_message',
  'tool/call': 'tool_call',
  'tool/result': 'tool_result',
}

/** A session-local identifier that points back to the exact raw event sequence. */
export function eventId(seq: number): string {
  return `event-${seq}`
}

/** Parse an index identifier without accepting ambiguous values. */
export function parseEventId(id: string): number | undefined {
  const match = /^event-(0|[1-9]\d*)$/.exec(id)
  if (match === null) return undefined
  const seq = Number(match[1])
  return Number.isSafeInteger(seq) ? seq : undefined
}

/**
 * In-memory directory over one or more DSH Session event streams.
 *
 * The index intentionally contains no copied event text or semantic labels.
 * SubSteps provide the semantic navigation layer in this MVP.
 */
export class HistoryIndex {
  private readonly sessions = new Map<string, Map<number, IndexedHistoryEvent>>()

  rebuild(sessionId: string, events: readonly RawHistoryEvent[]): void {
    const entries = new Map<number, IndexedHistoryEvent>()
    for (const event of events) this.addTo(entries, event)
    this.sessions.set(sessionId, entries)
  }

  append(sessionId: string, event: RawHistoryEvent): void {
    let entries = this.sessions.get(sessionId)
    if (entries === undefined) {
      entries = new Map()
      this.sessions.set(sessionId, entries)
    }
    this.addTo(entries, event)
  }

  entries(sessionId: string): HistoryIndexEntry[] {
    const entries = this.sessions.get(sessionId)
    if (entries === undefined) return []
    return [...entries.values()]
      .sort((left, right) => left.seq - right.seq)
      .map(({ id, kind }) => ({ id, kind }))
  }

  /** List the newest matching entries without inferring semantic relevance. */
  list(
    sessionId: string,
    kind?: IndexedEventKind,
    limit = 10,
  ): HistoryIndexEntry[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100))
    return this.entries(sessionId)
      .filter(entry => kind === undefined || entry.kind === kind)
      .slice(-safeLimit)
      .reverse()
  }

  private addTo(entries: Map<number, IndexedHistoryEvent>, event: RawHistoryEvent): void {
    const kind = EVENT_KINDS[event.type]
    if (kind === undefined || entries.has(event.seq)) return
    entries.set(event.seq, {
      id: eventId(event.seq),
      kind,
      seq: event.seq,
    })
  }
}
