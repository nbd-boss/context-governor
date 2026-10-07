import { isEventId } from './ids.ts'

/** Require one non-empty text value at a durable JSON boundary. */
export function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

/** Require a list of non-empty text values at a durable JSON boundary. */
export function requireTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((item, index) => requireText(item, `${field}[${String(index)}]`))
}

/** Reject retired or misspelled fields in a durable JSON record. */
export function requireExactKeys(record: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${field} contains unexpected field: ${key}`)
  }
}

/** Require unique current-Session History event references. */
export function requireEventIds(value: unknown, field: string, allowEmpty = false): string[] {
  const ids = requireTextList(value, field)
  if (!allowEmpty && ids.length === 0) throw new Error(`${field} must contain at least one event-N identifier`)
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicate event identifiers`)
  if (ids.some(id => !isEventId(id))) throw new Error(`${field} contains an invalid event-N identifier`)
  return ids
}

