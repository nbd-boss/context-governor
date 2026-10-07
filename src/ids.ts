/** Opaque identifiers persisted by Context Governor. */
export type StepId = string & { readonly __stepId: unique symbol }
export type SubStateId = string & { readonly __subStateId: unique symbol }
export type SubStepId = string & { readonly __subStepId: unique symbol }
export type CriterionId = string & { readonly __criterionId: unique symbol }
export type ArtifactId = string & { readonly __artifactId: unique symbol }

type SequentialId = StepId | SubStateId | SubStepId | CriterionId | ArtifactId

const STEP_ID = /^step-(0*[1-9]\d*)$/
const SUB_STATE_ID = /^sub-state-(0*[1-9]\d*)$/
const SUB_STEP_ID = /^sub-step-(0*[1-9]\d*)$/
const CRITERION_ID = /^criterion-(0*[1-9]\d*)$/
const ARTIFACT_ID = /^artifact-(0*[1-9]\d*)$/
const EVENT_ID = /^event-(0|[1-9]\d*)$/

function parseSequentialId<T extends SequentialId>(value: unknown, field: string, pattern: RegExp, label: string): T {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${field} must be a plugin-generated ${label}-N identifier`)
  }
  return value as T
}

function formatSequentialId<T extends SequentialId>(prefix: string, sequence: number): T {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`${prefix} sequence must be a positive safe integer`)
  }
  return `${prefix}-${String(sequence).padStart(6, '0')}` as T
}

function sequenceOf(value: SequentialId, pattern: RegExp): number {
  const match = pattern.exec(value)
  if (match?.[1] === undefined) throw new Error(`Invalid persisted identifier: ${value}`)
  const sequence = Number(match[1])
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`Invalid persisted identifier: ${value}`)
  return sequence
}

function nextSequentialId<T extends SequentialId>(values: readonly T[], pattern: RegExp, prefix: string): T {
  const highest = values.reduce((maximum, value) => Math.max(maximum, sequenceOf(value, pattern)), 0)
  return formatSequentialId<T>(prefix, highest + 1)
}

/** Parse a persisted task-plan identity. */
export function parseStepId(value: unknown, field = 'step_id'): StepId {
  return parseSequentialId<StepId>(value, field, STEP_ID, 'step')
}

/** Parse a persisted per-Step state identity. */
export function parseSubStateId(value: unknown, field = 'sub_state_id'): SubStateId {
  return parseSequentialId<SubStateId>(value, field, SUB_STATE_ID, 'sub-state')
}

/** Parse a persisted action identity. */
export function validateSubStepId(value: unknown, field = 'sub_step_id'): SubStepId {
  return parseSequentialId<SubStepId>(value, field, SUB_STEP_ID, 'sub-step')
}

/** Parse one persisted Step completion criterion identity. */
export function parseCriterionId(value: unknown, field = 'criterion_id'): CriterionId {
  return parseSequentialId<CriterionId>(value, field, CRITERION_ID, 'criterion')
}

/** Parse a persisted reusable-result identity. */
export function parseArtifactId(value: unknown, field = 'artifact_id'): ArtifactId {
  return parseSequentialId<ArtifactId>(value, field, ARTIFACT_ID, 'artifact')
}

/** Allocate the next stable task-plan identity. */
export function nextStepId(values: readonly StepId[]): StepId {
  return nextSequentialId(values, STEP_ID, 'step')
}

/** Allocate the next stable per-Step state identity. */
export function nextSubStateId(values: readonly SubStateId[]): SubStateId {
  return nextSequentialId(values, SUB_STATE_ID, 'sub-state')
}

/** Allocate the next stable action identity. */
export function nextSubStepId(values: readonly SubStepId[]): SubStepId {
  return nextSequentialId(values, SUB_STEP_ID, 'sub-step')
}

/** Allocate the next stable Step completion criterion identity. */
export function nextCriterionId(values: readonly CriterionId[]): CriterionId {
  return nextSequentialId(values, CRITERION_ID, 'criterion')
}

/** Allocate the next stable Artifact identity. */
export function nextArtifactId(values: readonly ArtifactId[]): ArtifactId {
  return nextSequentialId(values, ARTIFACT_ID, 'artifact')
}

/** Check a current-Session raw History event reference without loading History. */
export function isEventId(value: unknown): value is `event-${number}` {
  return typeof value === 'string' && EVENT_ID.test(value)
}
