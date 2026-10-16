import assert from 'node:assert/strict'
import test from 'node:test'

import { ARTIFACT_SELECTION_GUIDANCE, CONTINUATION_RECOVERY_GUIDANCE, EVIDENCE_BOUNDARY_GUIDANCE, PLANNING_CORE_GUIDANCE, PRIOR_WORK_RETRIEVAL_POLICY, STEP_PLANNING_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE, SWITCH_RECONCILIATION_GUIDANCE, TASK_COMPLETION_CRITERIA_GUIDANCE, WORKFLOW_STATE_CLOSURE_GUIDANCE } from '../src/agent-guidance.ts'
import { ADVANCE_TASK_PROGRESS_DESCRIPTION } from '../src/tools/advance-task-progress-tool.ts'
import { REGISTER_ARTIFACT_DESCRIPTION } from '../src/tools/artifact-tools.ts'
import { RECORD_EPOCH_CONTINUATION_DESCRIPTION } from '../src/tools/record-epoch-continuation-tool.ts'
import { SWITCH_CONTEXT_DESCRIPTION } from '../src/tools/switch-context-tool.ts'

test('separates one planning core from Step and SubStep grain rules', () => {
  assert.match(PLANNING_CORE_GUIDANCE, /normalize every parent completion criterion/)
  assert.match(PLANNING_CORE_GUIDANCE, /Split a criterion that combines distinct outputs/)
  assert.match(PLANNING_CORE_GUIDANCE, /independently verifiable results/)
  assert.match(PLANNING_CORE_GUIDANCE, /independently proves the criterion/)
  assert.match(PLANNING_CORE_GUIDANCE, /never means partial contribution/)
  assert.match(PLANNING_CORE_GUIDANCE, /write stage must not claim validation delegated to a later stage/)
  assert.match(PLANNING_CORE_GUIDANCE, /Use covers/)
  assert.match(PLANNING_CORE_GUIDANCE, /jointly produce the same result/)
  assert.match(STEP_PLANNING_GUIDANCE, /major stages or milestones/)
  assert.match(STEP_PLANNING_GUIDANCE, /multiple Context Epochs/)
  assert.match(STEP_PLANNING_GUIDANCE, /bounded reconnaissance its first SubStep/)
  assert.match(STEP_PLANNING_GUIDANCE, /replace the entire pending plan before completing reconnaissance/)
  assert.match(STEP_PLANNING_GUIDANCE, /persists only step, status, and covers/)
  assert.match(STEP_PLANNING_GUIDANCE, /must not reinterpret or narrow/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /within one Context Epoch/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /step_completion_criteria/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /replace_pending_sub_step_plan/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /must not claim that an external action or write is complete/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /exact state transitions and read-back conditions/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /one tool call/)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, new RegExp(PLANNING_CORE_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, new RegExp(SUB_STEP_PLANNING_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('derives task criteria from the Mission before Step planning without creating another persisted layer', () => {
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /directly from the Mission/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /user-observable final condition/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /required coverage/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /do not weaken all, every, each, only, must, complete, or exact/)
})

test('closes required external actions against directly evidenced persistent state', () => {
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /external actions and affects a persistent business system/)
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /fields directly evidenced to represent that action's status or time/)
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /name their required final values in the completion criterion/)
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /verify them by read-back after the action/)
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /do not invent state semantics/)
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /determine whether an authoritative persistent system records that action's outcome/)
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /plan the post-action update or reconciliation and its read-back as part of the same Step/)
  assert.match(WORKFLOW_STATE_CLOSURE_GUIDANCE, /successful action call, output artifact, or observation in another system is not sufficient/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, new RegExp(WORKFLOW_STATE_CLOSURE_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('uses one evidence boundary before narrowing scope or persisting a derived result', () => {
  assert.match(EVIDENCE_BOUNDARY_GUIDANCE, /narrow task scope, exclude candidates/)
  assert.match(EVIDENCE_BOUNDARY_GUIDANCE, /equal identifier values from different systems/)
  assert.match(EVIDENCE_BOUNDARY_GUIDANCE, /cross-system identity mapping requires direct evidence/)
  assert.match(EVIDENCE_BOUNDARY_GUIDANCE, /do not update, overwrite, or delete an existing record/)
  assert.match(EVIDENCE_BOUNDARY_GUIDANCE, /do not persist the inference as a trusted result/)
  assert.match(PLANNING_CORE_GUIDANCE, new RegExp(EVIDENCE_BOUNDARY_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(ARTIFACT_SELECTION_GUIDANCE, new RegExp(EVIDENCE_BOUNDARY_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('registers only exact cross-Context inputs that later work will reuse', () => {
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /later work must reuse across Contexts/)
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /never modify or delete that Resource file/)
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /new absolute path/)
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /final deliverable that no later work will use as input/)
  assert.match(REGISTER_ARTIFACT_DESCRIPTION, /unverified or incomplete file/)
})

test('requires switch reconciliation without fabricating incomplete progress', () => {
  assert.match(SWITCH_RECONCILIATION_GUIDANCE, /reconcile actual work with the projected SubState/)
  assert.match(SWITCH_RECONCILIATION_GUIDANCE, /keep the current SubStep active/)
  assert.match(SWITCH_CONTEXT_DESCRIPTION, /follow the register_artifact policy/)
  assert.match(SWITCH_CONTEXT_DESCRIPTION, /Completing a SubStep does not itself require a Context switch/)
  assert.match(SWITCH_RECONCILIATION_GUIDANCE, /record_epoch_continuation/)
  assert.match(RECORD_EPOCH_CONTINUATION_DESCRIPTION, /current incomplete SubStep/)
  assert.match(RECORD_EPOCH_CONTINUATION_DESCRIPTION, /replaces the earlier Continuation/)
  assert.doesNotMatch(SWITCH_CONTEXT_DESCRIPTION, /sub_step_outcome/)
})

test('uses verified Artifacts before raw recovery or repeated external queries', () => {
  const guidance = [PRIOR_WORK_RETRIEVAL_POLICY.scope, ...PRIOR_WORK_RETRIEVAL_POLICY.order].join(' ')
  assert.match(guidance, /Artifact coverage plus available_fields/)
  assert.match(guidance, /call read_artifact/)
  assert.ok(guidance.indexOf('call read_artifact') < guidance.indexOf('raw History or ordinary workspace files'))
  assert.ok(guidance.indexOf('raw History or ordinary workspace files') < guidance.indexOf('Re-query an external system'))
  assert.match(guidance, /read_artifact reports stale/)
})

test('treats a Continuation as an exact recovery handoff rather than a prompt to rediscover work', () => {
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /resume_from as the next work objective/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /do not re-derive or revalidate/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /declared working_resource only when its exact contents are required/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /next bounded portion/)
  assert.match(RECORD_EPOCH_CONTINUATION_DESCRIPTION, /must not merely say to continue working/)
})
