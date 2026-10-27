import { requireExactKeys } from '../contract-utils.ts'

export type PendingEdit<T> =
  | { operation: 'add'; value: T }
  | { operation: 'update'; id: string; value: T }
  | { operation: 'delete'; id: string }

type ChangeRecord = Record<string, unknown> & { operation: PendingEdit<unknown>['operation'] }

/** Validate the operation branch before a planning layer interprets its fields. */
export function readPendingChange(value: unknown, idKey: string, draftKeys: readonly string[]): ChangeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('change must be an object')
  const change = value as Record<string, unknown>
  if (change.operation !== 'add' && change.operation !== 'update' && change.operation !== 'delete') {
    throw new Error('change.operation must be add, update, or delete')
  }
  requireExactKeys(change, 'change', change.operation === 'add'
    ? ['operation', ...draftKeys]
    : change.operation === 'update' ? ['operation', idKey, ...draftKeys] : ['operation', idKey])
  return change as ChangeRecord
}

/** Shared list edit: append new work; retain the identity and position of an update. */
export function editPendingItems<T>(items: readonly T[], edit: PendingEdit<T>, idOf: (item: T) => string, canEdit: (item: T) => boolean): T[] {
  if (edit.operation === 'add') return [...items, edit.value]
  const index = items.findIndex(item => idOf(item) === edit.id)
  if (index === -1 || !canEdit(items[index]!)) throw new Error(`Only existing pending items can be revised: ${edit.id}`)
  if (edit.operation === 'delete') return items.filter((_item, position) => position !== index)
  if (JSON.stringify(items[index]) === JSON.stringify(edit.value)) throw new Error('change must make a substantive plan change')
  return items.map((item, position) => position === index ? edit.value : item)
}
