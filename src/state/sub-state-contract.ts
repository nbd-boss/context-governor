import { requireEventIds, requireExactKeys, requireText } from '../contract-utils.ts'
import {
  parseArtifactId,
  parseCriterionId,
  parseStepId,
  nextSubStepId,
  validateSubStepId,
  type ArtifactId,
  type CriterionId,
  type StepId,
  type SubStepId,
} from '../ids.ts'

export interface ArtifactRef {
  artifact_id: ArtifactId
  relation: 'produced' | 'used'
}

export interface StepCompletionCriterion {
  criterion_id: CriterionId
  criterion: string
}

export interface PlannedSubStep {
  sub_step_id: SubStepId
  action: string
  covers: CriterionId[]
}

/** Evidence explicitly attached to one Step completion criterion. */
export interface CriterionEvidence {
  criterion_id: CriterionId
  source_events: string[]
}

export interface CompletedSubStep extends PlannedSubStep {
  summary: string
  criterion_evidence: CriterionEvidence[]
  artifact_refs: ArtifactRef[]
}

export interface ContinuationWorkingResource {
  path: string
  contains: string
}

export interface SubStepContinuation {
  progress: string
  working_resources: ContinuationWorkingResource[]
  resume_from: string
}

export interface CurrentSubStep extends PlannedSubStep {
  continuation: SubStepContinuation | null
}

export interface PendingSubStep extends PlannedSubStep {}

export interface SubState {
  schema_version: 1
  step_id: StepId
  next_sub_step_number: number
  step_completion_criteria: StepCompletionCriterion[]
  superseded_criterion_ids: CriterionId[]
  completed_sub_steps: CompletedSubStep[]
  current_sub_step: CurrentSubStep | null
  pending_sub_steps: PendingSubStep[]
}

function validateArtifactRefs(value: unknown, field: string): ArtifactRef[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${field}[${String(index)}] must be an object`)
    const record = item as Record<string, unknown>
    requireExactKeys(record, `${field}[${String(index)}]`, ['artifact_id', 'relation'])
    const artifactId = parseArtifactId(record.artifact_id, `${field}[${String(index)}].artifact_id`)
    if (ids.has(artifactId)) throw new Error(`${field} contains duplicate artifact_id: ${artifactId}`)
    ids.add(artifactId)
    if (record.relation !== 'produced' && record.relation !== 'used') throw new Error(`${field}[${String(index)}].relation must be produced or used`)
    return { artifact_id: artifactId, relation: record.relation }
  })
}

function validateCriteria(value: unknown): StepCompletionCriterion[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('step_completion_criteria must be a non-empty array')
  const ids = new Set<string>()
  const labels = new Set<string>()
  return value.map((item, index) => {
    const field = `step_completion_criteria[${String(index)}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${field} must be an object`)
    const record = item as Record<string, unknown>
    requireExactKeys(record, field, ['criterion_id', 'criterion'])
    const criterionId = parseCriterionId(record.criterion_id, `${field}.criterion_id`)
    const criterion = requireText(record.criterion, `${field}.criterion`)
    if (ids.has(criterionId)) throw new Error(`step_completion_criteria contains duplicate criterion_id: ${criterionId}`)
    if (labels.has(criterion)) throw new Error(`step_completion_criteria contains duplicate criterion: ${criterion}`)
    ids.add(criterionId)
    labels.add(criterion)
    return { criterion_id: criterionId, criterion }
  })
}

function validateCovers(value: unknown, field: string, validCriteria: ReadonlySet<string>): CriterionId[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`)
  const ids = new Set<string>()
  return value.map((item, index) => {
    const criterionId = parseCriterionId(item, `${field}[${String(index)}]`)
    if (!validCriteria.has(criterionId)) throw new Error(`${field} references unknown criterion_id: ${criterionId}`)
    if (ids.has(criterionId)) throw new Error(`${field} contains duplicate criterion_id: ${criterionId}`)
    ids.add(criterionId)
    return criterionId
  })
}

function validatePlannedSubStep(value: unknown, field: string, validCriteria: ReadonlySet<string>): PlannedSubStep {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const record = value as Record<string, unknown>
  requireExactKeys(record, field, ['sub_step_id', 'action', 'covers'])
  return {
    sub_step_id: validateSubStepId(record.sub_step_id, `${field}.sub_step_id`),
    action: requireText(record.action, `${field}.action`),
    covers: validateCovers(record.covers, `${field}.covers`, validCriteria),
  }
}

export function criterionEvidenceEventIds(evidence: readonly CriterionEvidence[]): string[] {
  return [...new Set(evidence.flatMap(item => item.source_events))]
}

export function validateCriterionEvidence(
  value: unknown,
  expectedCriterionIds: readonly CriterionId[],
  field: string,
): CriterionEvidence[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  const expected = new Set(expectedCriterionIds)
  const seen = new Set<string>()
  const evidence = value.map((item, index) => {
    const itemField = `${field}[${String(index)}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemField} must be an object`)
    const record = item as Record<string, unknown>
    requireExactKeys(record, itemField, ['criterion_id', 'source_events'])
    const criterionId = parseCriterionId(record.criterion_id, `${itemField}.criterion_id`)
    if (!expected.has(criterionId)) throw new Error(`${itemField}.criterion_id does not belong to the completed SubStep: ${criterionId}`)
    if (seen.has(criterionId)) throw new Error(`${field} contains duplicate criterion_id: ${criterionId}`)
    seen.add(criterionId)
    return { criterion_id: criterionId, source_events: requireEventIds(record.source_events, `${itemField}.source_events`) }
  })
  for (const criterionId of expectedCriterionIds) {
    if (!seen.has(criterionId)) throw new Error(`${field} is missing evidence for criterion_id: ${criterionId}`)
  }
  return evidence
}

function validateCompletedSubStep(value: unknown, field: string, validCriteria: ReadonlySet<string>): CompletedSubStep {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const record = value as Record<string, unknown>
  requireExactKeys(record, field, ['sub_step_id', 'action', 'covers', 'summary', 'criterion_evidence', 'artifact_refs'])
  const planned = validatePlannedSubStep({
    sub_step_id: record.sub_step_id,
    action: record.action,
    covers: record.covers,
  }, field, validCriteria)
  return {
    ...planned,
    summary: requireText(record.summary, `${field}.summary`),
    criterion_evidence: validateCriterionEvidence(record.criterion_evidence, planned.covers, `${field}.criterion_evidence`),
    artifact_refs: validateArtifactRefs(record.artifact_refs, `${field}.artifact_refs`),
  }
}

export function validateSubStepContinuation(value: unknown, field = 'continuation'): SubStepContinuation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const record = value as Record<string, unknown>
  requireExactKeys(record, field, ['progress', 'working_resources', 'resume_from'])
  if (!Array.isArray(record.working_resources)) {
    throw new Error(`${field}.working_resources must be an array`)
  }
  const paths = new Set<string>()
  const workingResources = record.working_resources.map((item, index) => {
    const itemField = `${field}.working_resources[${String(index)}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemField} must be an object`)
    const resource = item as Record<string, unknown>
    requireExactKeys(resource, itemField, ['path', 'contains'])
    const path = requireText(resource.path, `${itemField}.path`)
    if (paths.has(path)) throw new Error(`${field}.working_resources contains duplicate path: ${path}`)
    paths.add(path)
    return { path, contains: requireText(resource.contains, `${itemField}.contains`) }
  })
  return {
    progress: requireText(record.progress, `${field}.progress`),
    working_resources: workingResources,
    resume_from: requireText(record.resume_from, `${field}.resume_from`),
  }
}

function validateCurrentSubStep(value: unknown, field: string, validCriteria: ReadonlySet<string>): CurrentSubStep {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object or null`)
  const record = value as Record<string, unknown>
  requireExactKeys(record, field, ['sub_step_id', 'action', 'covers', 'continuation'])
  const planned = validatePlannedSubStep({
    sub_step_id: record.sub_step_id,
    action: record.action,
    covers: record.covers,
  }, field, validCriteria)
  return {
    ...planned,
    continuation: record.continuation === null ? null : validateSubStepContinuation(record.continuation, `${field}.continuation`),
  }
}

export function validateSubState(value: unknown): SubState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('SubState must be an object')
  const record = value as Record<string, unknown>
  requireExactKeys(record, 'SubState', [
    'schema_version',
    'step_id',
    'next_sub_step_number',
    'step_completion_criteria',
    'superseded_criterion_ids',
    'completed_sub_steps',
    'current_sub_step',
    'pending_sub_steps',
  ])
  if (record.schema_version !== 1) throw new Error(`Unsupported SubState schema_version: ${String(record.schema_version)}`)
  const criteria = validateCriteria(record.step_completion_criteria)
  const criterionIds = new Set(criteria.map(item => item.criterion_id))
  if (!Array.isArray(record.superseded_criterion_ids)) throw new Error('superseded_criterion_ids must be an array')
  const superseded = record.superseded_criterion_ids.map((item, index) => {
    const id = parseCriterionId(item, `superseded_criterion_ids[${String(index)}]`)
    if (!criterionIds.has(id)) throw new Error(`superseded_criterion_ids references unknown criterion_id: ${id}`)
    return id
  })
  if (new Set(superseded).size !== superseded.length) throw new Error('superseded_criterion_ids contains duplicates')
  if (superseded.length === criteria.length) throw new Error('SubState requires at least one active completion criterion')
  if (!Array.isArray(record.completed_sub_steps)) throw new Error('completed_sub_steps must be an array')
  if (!Array.isArray(record.pending_sub_steps)) throw new Error('pending_sub_steps must be an array')
  const completed = record.completed_sub_steps.map((item, index) => validateCompletedSubStep(item, `completed_sub_steps[${String(index)}]`, criterionIds))
  const current = record.current_sub_step === null ? null : validateCurrentSubStep(record.current_sub_step, 'current_sub_step', criterionIds)
  const pending = record.pending_sub_steps.map((item, index) => validatePlannedSubStep(item, `pending_sub_steps[${String(index)}]`, criterionIds))
  for (const item of pending) {
    if (item.covers.some(id => superseded.includes(id))) throw new Error(`Pending SubStep cannot claim a superseded criterion: ${item.sub_step_id}`)
  }
  const ids = new Set<string>()
  const all = [...completed, ...(current === null ? [] : [current]), ...pending]
  for (const subStep of all) {
    if (ids.has(subStep.sub_step_id)) throw new Error(`SubState contains duplicate sub_step_id: ${subStep.sub_step_id}`)
    ids.add(subStep.sub_step_id)
  }
  const nextNumber = record.next_sub_step_number
  if (!Number.isSafeInteger(nextNumber) || (nextNumber as number) < Number(nextSubStepId(all.map(item => item.sub_step_id)).slice(9))) {
    throw new Error('next_sub_step_number must be a safe integer greater than every allocated SubStep ID')
  }
  const covered = new Set(all.flatMap(item => item.covers))
  for (const criterion of criteria) {
    if (!superseded.includes(criterion.criterion_id) && !covered.has(criterion.criterion_id)) throw new Error(`Step completion criterion is not covered by any SubStep: ${criterion.criterion_id}`)
  }
  return {
    schema_version: 1,
    step_id: parseStepId(record.step_id),
    next_sub_step_number: nextNumber as number,
    step_completion_criteria: criteria,
    superseded_criterion_ids: superseded,
    completed_sub_steps: completed,
    current_sub_step: current,
    pending_sub_steps: pending,
  }
}
