/** Check references against the execution History supplied by the tool environment, without interpreting content. */
export function requireSessionEventIds(value: unknown, events: readonly { seq: number }[], field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^event-(0|[1-9]\d*)$/.test(id))) {
    throw new Error(`${field} must contain one or more event-N identifiers`)
  }
  const missing = value.filter(id => !events.some(event => event.seq === Number(id.slice('event-'.length))))
  if (missing.length > 0) {
    throw new Error(`${field}: events not found in the current execution History: ${missing.join(', ')}. Use existing event-N identifiers.`)
  }
}

